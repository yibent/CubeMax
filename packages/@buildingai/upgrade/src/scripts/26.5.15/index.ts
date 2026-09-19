import UpstreamUserRepair from "../26.1.2";

/** Replay upstream data repairs for CubeMax installations already above 26.1.2. */
export default class Upgrade extends UpstreamUserRepair {
    override readonly version: string = "26.5.15";
}
