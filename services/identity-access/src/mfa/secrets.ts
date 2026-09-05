import { SecretBox as KitSecretBox, sha256hex } from '@maritime/service-kit';

/** Authenticator secrets rest sealed with the deployment's own key, under the `mfa` purpose the seeds were sealed with. */
export class SecretBox extends KitSecretBox { constructor(material: string) { super(material, 'mfa'); } }
export { sha256hex };
