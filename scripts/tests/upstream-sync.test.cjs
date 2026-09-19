const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");

// Compile the real source while replacing only infrastructure boundaries.
// This keeps regression tests independent of database/network credentials.
function loadSource(relativePath, mocks = {}) {
    const filename = path.join(root, relativePath);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
            esModuleInterop: true,
        },
    });
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    const requireWithMocks = (id) => (Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id));
    new Function("require", "module", "exports", outputText)(
        requireWithMocks,
        module,
        module.exports,
    );
    return module.exports;
}

const { resolveOpenAIApiMode } = loadSource(
    "packages/@buildingai/ai-sdk/src/providers/openai/api-mode.ts",
);
for (const [model, url, override, expected] of [
    ["gpt-4.1", undefined, undefined, "responses"],
    ["gpt-4o-mini", "https://api.openai.com/v1", undefined, "responses"],
    ["gpt-4-turbo", undefined, undefined, "chat"],
    ["gpt-4o-audio-preview", undefined, undefined, "chat"],
    ["o1-mini", undefined, undefined, "chat"],
    ["gpt-5", "https://compatible.example/v1", undefined, "chat"],
    ["gpt-5", "https://api.openai.com.evil.example/v1", undefined, "chat"],
    ["gpt-5", "not a URL", undefined, "chat"],
    ["unknown-model", undefined, undefined, "chat"],
    ["ft:gpt-4.1:org:custom", undefined, undefined, "responses"],
    ["gpt-5", "https://compatible.example/v1", "responses", "responses"],
    ["gpt-5", undefined, "chat", "chat"],
]) {
    test(`OpenAI routing: ${model}, ${url}, ${override}`, () => {
        assert.equal(resolveOpenAIApiMode(model, url, override), expected);
    });
}

const { processFiles } = loadSource("packages/@buildingai/ai-toolkit/src/utils/process-files.ts");
const { buildAttachedFilesSection } = loadSource(
    "packages/@buildingai/ai-toolkit/src/prompts/attached-files.prompt.ts",
);

test("only current documents are parsed; historical media and tool parts survive", async () => {
    const image = { type: "file", mediaType: "image/png", url: "https://example/old.png" };
    const tool = { type: "tool-result", output: "ok" };
    const messages = [
        { role: "user", parts: [{ type: "file", filename: "old.pdf", url: "old" }, image] },
        { role: "assistant", parts: [tool] },
        { role: "user", parts: [{ type: "file", filename: "new.pdf", url: "new" }] },
    ];
    const original = structuredClone(messages);
    const parsed = [];
    const result = await processFiles(messages, { write() {} }, async (part) => {
        parsed.push(part.url);
        return { filename: part.filename, content: "new content", progressParts: [] };
    });
    assert.deepEqual(parsed, ["new"]);
    assert.deepEqual(result.documentContents, [{ filename: "new.pdf", content: "new content" }]);
    assert.match(result.messages[0].parts[0].text, /old.pdf/);
    assert.equal(result.messages[0].parts[1], image);
    assert.equal(result.messages[1].parts[0], tool);
    assert.deepEqual(messages, original);
});

test("duplicate current filenames remain independently addressable", async () => {
    const result = await processFiles(
        [{ role: "user", parts: ["a", "b"].map((url) => ({ type: "file", url })) }],
        { write() {} },
        async (part) => ({ filename: "report.pdf", content: part.url, progressParts: [] }),
    );
    assert.deepEqual(
        result.documentContents.map((doc) => doc.filename),
        ["report.pdf", "report (2).pdf"],
    );
    for (const toolMode of [true, false]) {
        const prompt = buildAttachedFilesSection(result.documentContents, toolMode);
        assert.match(prompt, /CURRENT/);
        assert.match(prompt, /report \(2\).pdf/);
    }
});

class BaseService {}
const decorator = () => () => {};
const errorFactory = Object.fromEntries(
    ["badRequest", "notFound", "business", "unauthorized"].map((name) => [
        name,
        (message) => new Error(message),
    ]),
);
const serviceMocks = {
    "@buildingai/base": { BaseService },
    "@buildingai/db/@nestjs/typeorm": { InjectRepository: decorator },
    "@buildingai/db/entities": {},
    "@buildingai/errors": { HttpErrorFactory: errorFactory },
    "@nestjs/common": { Injectable: decorator, Inject: decorator, Optional: decorator },
};
const { SecretService } = loadSource(
    "packages/core/src/modules/secret/services/secret.service.ts",
    {
        ...serviceMocks,
        "@buildingai/constants": { BooleanNumber: { YES: 1, NO: 0 } },
        "@buildingai/db/typeorm": {},
        "@buildingai/utils": {
            decryptValue: () => {
                throw new Error("disabled secret was decrypted");
            },
        },
    },
);

test("disabled credentials are rejected before decrypting their values", async () => {
    const service = new SecretService({
        findOne: async () => ({
            status: false,
            fieldValues: [{ name: "apiKey", value: "encrypted", encrypted: true }],
        }),
    });
    await assert.rejects(service.getConfigKeyValuePairs("disabled"), /未开启/);
});
test("enabled credentials retain value and required-field metadata", async () => {
    const service = new SecretService({
        findOne: async () => ({
            status: true,
            fieldValues: [{ name: "apiKey", value: "test-key" }],
            template: { fieldConfig: [{ name: "apiKey", required: true }] },
        }),
    });
    assert.deepEqual(await service.getConfigKeyValuePairs("enabled"), {
        apiKey: { value: "test-key", required: true },
    });
});

const { AuthService } = loadSource(
    "packages/api/src/common/modules/auth/services/auth.service.ts",
    {
        ...serviceMocks,
        "@assets/nickname.json": [],
        "@buildingai/constants/shared/business-code.constant": { BusinessCode: {} },
        "@buildingai/constants/shared/status-codes.constant": {},
        "@buildingai/db": {},
        "@buildingai/utils": {},
    },
);
test("first password setup hashes the password without invalidating the session", async () => {
    const service = Object.create(AuthService.prototype);
    service.findOne = async () => ({ id: "user", password: "" });
    let saved;
    service.updateById = async (id, value) => {
        saved = { id, ...value };
    };
    service.userTokenService = new Proxy(
        {},
        {
            get() {
                throw new Error("session must be retained");
            },
        },
    );
    await service.setPassword("user", "abc12345", "abc12345");
    const bcrypt = createRequire(path.join(root, "packages/api/package.json"))("bcryptjs");
    assert.equal(saved.id, "user");
    assert.notEqual(saved.password, "abc12345");
    assert.equal(await bcrypt.compare("abc12345", saved.password), true);
});
test("first password setup cannot replace an existing password or accept mismatches", async () => {
    const service = Object.create(AuthService.prototype);
    service.findOne = async () => ({ id: "user", password: "existing-hash" });
    service.updateById = async () => {
        throw new Error("unexpected update");
    };
    await assert.rejects(service.setPassword("user", "abc12345", "abc12345"), /已设置密码/);
    await assert.rejects(service.setPassword("user", "abc12345", "different"), /不一致/);
});

const operators = {
    IsNull: () => ({ op: "null" }),
    Not: (value) => ({ op: "not", value }),
    MoreThan: (value) => ({ op: "gt", value }),
};
class BaseUpgradeScript {
    log() {}
    success() {}
    error() {}
}
const Upgrade = loadSource("packages/@buildingai/upgrade/src/scripts/26.1.2/index.ts", {
    "@buildingai/db/entities": { User: class User {} },
    "@buildingai/db/typeorm": operators,
    "../../index": { BaseUpgradeScript },
}).default;
const CubeMaxUpgrade = loadSource("packages/@buildingai/upgrade/src/scripts/26.5.15/index.ts", {
    "../26.1.2": { default: Upgrade, __esModule: true },
}).default;

function matches(actual, expected) {
    if (expected?.op === "null") return actual == null;
    if (expected?.op === "not") return !matches(actual, expected.value);
    if (expected?.op === "gt") return actual > expected.value;
    return actual === expected;
}
function fixture(rows) {
    let reads = 0;
    let writes = 0;
    const repo = {
        async find(options) {
            assert.ok(++reads < 50, "migration must make forward progress");
            const conditions = Array.isArray(options.where) ? options.where : [options.where];
            return rows
                .filter(
                    (row) =>
                        (options.withDeleted || !row.deletedAt) &&
                        conditions.some((where) =>
                            Object.entries(where).every(([key, value]) => matches(row[key], value)),
                        ),
                )
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, options.take ?? rows.length);
        },
        async count(options) {
            return (await this.find(options)).length;
        },
        async update(id, fields) {
            writes++;
            Object.assign(
                rows.find((row) => row.id === id),
                fields,
            );
        },
        createQueryBuilder() {
            return {
                select() {
                    return this;
                },
                where() {
                    return this;
                },
                async getRawMany() {
                    return rows.filter((row) => row.userNo).map(({ userNo }) => ({ userNo }));
                },
            };
        },
    };
    return { context: { dataSource: { getRepository: () => repo } }, writes: () => writes };
}

test("CubeMax 26.5.15 repairs multiple batches and is safe to rerun", async () => {
    const rows = Array.from({ length: 1102 }, (_, i) => ({
        id: String(i).padStart(8, "0"),
        username: i === 0 ? "x".repeat(255) : `user-${i}`,
        deletedAt: i < 551 ? new Date() : null,
        openid: `openid-${i}`,
        mpOpenid: `mp-${i}`,
        unionid: `union-${i}`,
        userNo: i < 551 ? `existing-${i}` : i % 2 ? null : "",
        createdAt: new Date("2026-08-01T00:00:00Z"),
    }));
    const db = fixture(rows);
    const upgrade = new CubeMaxUpgrade();
    assert.equal(upgrade.version, "26.5.15");
    await upgrade.execute(db.context);
    assert.ok(
        rows
            .slice(0, 551)
            .every(
                (row) =>
                    row.openid === null &&
                    row.mpOpenid === null &&
                    row.unionid === null &&
                    row.username.endsWith(`__deleted_${row.id}`),
            ),
    );
    assert.ok(rows.every((row) => row.username.length <= 255));
    assert.ok(rows.slice(551).every((row) => row.userNo && row.openid));
    assert.equal(new Set(rows.map((row) => row.userNo)).size, rows.length);
    const writes = db.writes();
    await upgrade.execute(db.context);
    assert.equal(db.writes(), writes, "rerunning must not repeatedly rename deleted users");
});

test("exhausted user-number collisions fail instead of looping forever", async () => {
    const db = fixture([
        { id: "1", userNo: "collision", deletedAt: null },
        { id: "2", userNo: "", deletedAt: null, createdAt: new Date() },
    ]);
    const upgrade = new CubeMaxUpgrade();
    upgrade.generateUserNo = () => "collision";
    await assert.rejects(upgrade.execute(db.context), /Unable to generate unique userNo/);
});
