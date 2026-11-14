import { mail, mailAgents, mailIdentity } from "@botlake/extension-ct-config";
import identityExtension from "@botlake/extension-identity";

export const mailExtensions = [identityExtension, mail, mailIdentity, mailAgents];
