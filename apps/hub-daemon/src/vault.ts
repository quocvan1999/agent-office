import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDirLayout } from "./policy.ts";

export interface VaultEntryMeta {
  name: string;
  provider: string;
  baseUrl?: string;
  updatedAt: string;
}

interface VaultEntry extends VaultEntryMeta {
  secret: string;
}

interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SecretsVault {
  readonly vaultPath: string;
  private key?: Buffer;
  private entries = new Map<string, VaultEntry>();

  constructor(customPath?: string) {
    const dataDir = ensureDataDirLayout();
    this.vaultPath = customPath ?? join(dataDir, "vault", "secrets.enc");
  }

  isUnlocked(): boolean {
    return Boolean(this.key);
  }

  existsOnDisk(): boolean {
    return existsSync(this.vaultPath);
  }

  unlock(passphrase: string): void {
    if (!passphrase || passphrase.length < 6) {
      throw new Error("Passphrase must be at least 6 characters");
    }
    if (!existsSync(this.vaultPath)) {
      const salt = randomBytes(16);
      this.key = scryptSync(passphrase, salt, 32);
      this.entries.clear();
      this.persist(salt);
      return;
    }

    const envelope = JSON.parse(readFileSync(this.vaultPath, "utf8")) as EncryptedEnvelope;
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");

    const derived = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", derived, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    const parsed = JSON.parse(plaintext) as VaultEntry[];
    this.key = derived;
    this.entries.clear();
    for (const item of parsed) {
      this.entries.set(item.name, item);
    }
  }

  lock(): void {
    if (this.key) this.key.fill(0);
    this.key = undefined;
    this.entries.clear();
  }

  setSecret(name: string, provider: string, secret: string, baseUrl?: string): void {
    if (!this.key) throw new Error("Vault is locked");
    this.entries.set(name, {
      name,
      provider,
      baseUrl,
      secret,
      updatedAt: new Date().toISOString(),
    });
    const salt = existsSync(this.vaultPath)
      ? Buffer.from((JSON.parse(readFileSync(this.vaultPath, "utf8")) as EncryptedEnvelope).salt, "base64")
      : randomBytes(16);
    this.persist(salt);
  }

  getSecret(name: string): string | undefined {
    if (!this.key) throw new Error("Vault is locked");
    return this.entries.get(name)?.secret;
  }

  listMetadata(): VaultEntryMeta[] {
    return Array.from(this.entries.values()).map(({ name, provider, baseUrl, updatedAt }) => ({
      name,
      provider,
      baseUrl,
      updatedAt,
    }));
  }

  deleteSecret(name: string): boolean {
    if (!this.key) throw new Error("Vault is locked");
    const deleted = this.entries.delete(name);
    if (deleted && existsSync(this.vaultPath)) {
      const salt = Buffer.from(
        (JSON.parse(readFileSync(this.vaultPath, "utf8")) as EncryptedEnvelope).salt,
        "base64"
      );
      this.persist(salt);
    }
    return deleted;
  }

  private persist(salt: Buffer): void {
    if (!this.key) throw new Error("Vault is locked");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const payload = JSON.stringify(Array.from(this.entries.values()));
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
      v: 1,
      alg: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    writeFileSync(this.vaultPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    chmodSync(this.vaultPath, 0o600);
  }
}
