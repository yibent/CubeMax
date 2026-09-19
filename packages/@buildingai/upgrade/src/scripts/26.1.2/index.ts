import { User } from "@buildingai/db/entities";
import { IsNull, MoreThan, Not, Repository } from "@buildingai/db/typeorm";

import { BaseUpgradeScript, type UpgradeContext } from "../../index";

/**
 * 每批处理的用户数量
 */
const BATCH_SIZE = 500;

/**
 * Core upgrade script for version 26.1.2
 *
 * - 清理已注销用户占用的 openid、mpOpenid、unionid 和 username 唯一约束
 * - 为 userNo 为 NULL 或空字符串的老用户批量生成唯一编号
 */
export default class Upgrade extends BaseUpgradeScript {
    readonly version: string = "26.1.2";

    /**
     * Runs data fixes for 26.1.2
     *
     * @param context - Upgrade context (DB and services)
     */
    async execute(context: UpgradeContext): Promise<void> {
        this.log(`Starting user data repair for version ${this.version}`);

        try {
            await this.clearDeletedUserOpenid(context);
            await this.backfillUserNos(context);
            this.success(`Upgrade ${this.version} completed`);
        } catch (error) {
            this.error(`Upgrade ${this.version} failed`, error);
            throw error;
        }
    }

    /**
     * 清理已注销用户的 openid、mpOpenid、unionid 和 username
     *
     * 已注销用户的 openid、mpOpenid、unionid 和 username 仍然占用唯一约束，
     * 导致新用户无法使用相同的 openid 或 username 注册。
     * 此方法将这些已注销用户的 openid、mpOpenid、unionid 清空，
     * 并将 username 改为 username + 用户ID。
     *
     * @param context - Upgrade context
     */
    private async clearDeletedUserOpenid(context: UpgradeContext): Promise<void> {
        const repo = context.dataSource.getRepository(User) as Repository<User>;

        // Cursor pagination is required: tombstoned usernames remain non-null, so
        // repeatedly selecting the first batch would miss every later batch.
        let lastId: string | undefined;
        let processed = 0;
        while (true) {
            const users = await repo.find({
                where: {
                    deletedAt: Not(IsNull()),
                    ...(lastId ? { id: MoreThan(lastId) } : {}),
                },
                select: ["id", "openid", "mpOpenid", "unionid", "username"],
                order: { id: "ASC" },
                take: BATCH_SIZE,
                withDeleted: true,
            });
            if (users.length === 0) break;

            for (const user of users) {
                const suffix = `__deleted_${user.id}`;
                const username = user.username?.endsWith(suffix)
                    ? user.username
                    : `${(user.username ?? "").slice(0, 255 - suffix.length)}${suffix}`;
                if (user.openid || user.mpOpenid || user.unionid || user.username !== username) {
                    await repo.update(user.id, {
                        openid: null as any,
                        mpOpenid: null as any,
                        unionid: null as any,
                        username,
                    });
                    processed++;
                }
            }
            lastId = users[users.length - 1]!.id;
        }
        this.log(`Deleted user cleanup complete: ${processed} users cleaned`);
    }

    /**
     * 为 userNo 为 NULL 或空字符串的老用户批量生成唯一编号
     *
     * 生成规则与 generateNo 一致：日期前缀(YYYYMMDDHHmmss) + 6位随机数字
     *
     * @param context - Upgrade context
     */
    private async backfillUserNos(context: UpgradeContext): Promise<void> {
        const repo = context.dataSource.getRepository(User) as Repository<User>;

        // 统计需要处理的用户总数
        const totalNull = await repo.count({
            where: [{ userNo: IsNull() }, { userNo: "" }],
        });
        if (totalNull === 0) {
            this.log("All users already have userNo, skip");
            return;
        }
        this.log(`Found ${totalNull} users with NULL or empty userNo, starting backfill...`);

        let processed = 0;
        const existingSet = new Set(await this.getExistingUserNos(repo));

        while (true) {
            // 查询本批 NULL 或空字符串用户，取 id 和 createdAt
            const users = await repo.find({
                where: [{ userNo: IsNull() }, { userNo: "" }],
                select: ["id", "createdAt"],
                take: BATCH_SIZE,
            });

            if (users.length === 0) {
                break;
            }

            // 为本批用户生成唯一 userNo
            const updates: Array<{ id: string; userNo: string }> = [];
            for (const user of users) {
                let userNo = this.generateUserNo(user.createdAt ?? new Date());
                // 确保不与已有 userNo 重复，也不与本批已生成的重复
                let attempts = 0;
                while (existingSet.has(userNo) || updates.some((u) => u.userNo === userNo)) {
                    userNo = this.generateUserNo(user.createdAt ?? new Date());
                    attempts++;
                    if (attempts > 10) {
                        // Fail rather than selecting the same unresolved batch forever.
                        throw new Error(`Unable to generate unique userNo for user ${user.id}`);
                    }
                }
                if (attempts <= 10) {
                    updates.push({ id: user.id, userNo });
                    existingSet.add(userNo);
                }
            }

            // 批量更新
            for (const update of updates) {
                await repo.update(update.id, { userNo: update.userNo });
            }

            processed += updates.length;
            this.log(
                `Batch done: ${updates.length} users updated (total: ${processed}/${totalNull})`,
            );
        }

        this.log(`UserNo backfill complete: ${processed} users updated`);
    }

    /**
     * 获取数据库中所有已存在的 userNo
     *
     * @param repo - User repository
     * @returns 已存在的 userNo 数组
     */
    private async getExistingUserNos(repo: Repository<User>): Promise<string[]> {
        const result = await repo
            .createQueryBuilder("u")
            .select("u.userNo", "userNo")
            .where("u.userNo IS NOT NULL AND u.userNo != ''")
            .getRawMany<{ userNo: string }>();
        return result.map((r) => r.userNo);
    }

    /**
     * 生成唯一用户编号，格式与 generateNo 一致
     *
     * @param date - 日期时间基准，默认当前时间
     * @returns 日期前缀(YYYYMMDDHHmmss) + 6 位随机数字
     */
    private generateUserNo(date: Date = new Date()): string {
        const now = date;
        const datePrefix = [
            now.getFullYear(),
            (now.getMonth() + 1).toString().padStart(2, "0"),
            now.getDate().toString().padStart(2, "0"),
            now.getHours().toString().padStart(2, "0"),
            now.getMinutes().toString().padStart(2, "0"),
            now.getSeconds().toString().padStart(2, "0"),
        ].join("");

        let suffix = "";
        for (let i = 0; i < 6; i++) {
            suffix += Math.floor(Math.random() * 10);
        }

        return `${datePrefix}${suffix}`;
    }
}
