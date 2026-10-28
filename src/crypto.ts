import { createCipheriv, createHash, createHmac, pbkdf2, randomFillSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync, gunzipSync } from 'node:zlib'
import { BaseCryptoProvider } from '@mtcute/core/utils.js'
import type { IAesCtr, ICryptoProvider, IEncryptionScheme } from '@mtcute/core/utils.js'
import { SIMD_AVAILABLE, ige256Decrypt, ige256Encrypt, initSync } from '@mtcute/wasm'

// Same as mtcute's Node crypto provider, except the wasm file is read from
// one fixed directory (next to the root-owned bundle). mtcute's own
// provider resolves it through the module search path.

export class PinnedCryptoProvider extends BaseCryptoProvider implements ICryptoProvider {
  constructor(private readonly wasmDir: string) {
    super()
  }

  async initialize(): Promise<void> {
    const file = SIMD_AVAILABLE ? 'mtcute-simd.wasm' : 'mtcute.wasm'
    initSync(await readFile(join(this.wasmDir, file)))
  }

  createAesCtr(key: Uint8Array, iv: Uint8Array): IAesCtr {
    const cipher = createCipheriv(`aes-${key.length * 8}-ctr`, key, iv)
    return { process: (data: Uint8Array) => cipher.update(data) }
  }

  createAesIge(key: Uint8Array, iv: Uint8Array): IEncryptionScheme {
    return {
      encrypt: (data: Uint8Array) => ige256Encrypt(data, key, iv),
      decrypt: (data: Uint8Array) => ige256Decrypt(data, key, iv),
    }
  }

  pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, keylen = 64, algo = 'sha512'): Promise<Uint8Array> {
    return new Promise((resolve, reject) =>
      pbkdf2(password, salt, iterations, keylen, algo, (err, buf) => (err !== null ? reject(err) : resolve(buf))),
    )
  }

  sha1(data: Uint8Array): Uint8Array {
    return createHash('sha1').update(data).digest()
  }

  sha256(data: Uint8Array): Uint8Array {
    return createHash('sha256').update(data).digest()
  }

  hmacSha256(data: Uint8Array, key: Uint8Array): Uint8Array {
    return createHmac('sha256', key).update(data).digest()
  }

  gzip(data: Uint8Array, maxSize: number): Uint8Array | null {
    try {
      return deflateSync(data, { maxOutputLength: maxSize })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return null
      throw e
    }
  }

  gunzip(data: Uint8Array): Uint8Array {
    return gunzipSync(data)
  }

  randomFill(buf: Uint8Array): void {
    randomFillSync(buf)
  }
}
