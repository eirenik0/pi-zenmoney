import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerZenMoneyExtension from "./zenmoney.ts";

export default function (pi: ExtensionAPI) {
	return registerZenMoneyExtension(pi);
}
