import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StoredRawFile {
  id: string;
  sha256: string;
  relativePath: string;
  originalName: string;
  mediaType: string;
  byteLength: number;
}

function safeExtension(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
}

export class RawFileStore {
  constructor(private readonly dataRoot: string) {}

  save(buffer: Buffer, originalName: string, mediaType: string): StoredRawFile {
    const sha256 = createHash('sha256').update(buffer).digest('hex').toUpperCase();
    const relativePath = path.join(
      'raw',
      sha256.slice(0, 2),
      `${sha256}${safeExtension(originalName)}`,
    );
    const destination = path.resolve(this.dataRoot, relativePath);
    const root = path.resolve(this.dataRoot);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('原始文件路径越出数据目录');

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination)) {
      const stagingDirectory = path.join(root, 'staging');
      fs.mkdirSync(stagingDirectory, { recursive: true });
      const temporary = path.join(stagingDirectory, `${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, buffer, { flag: 'wx' });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (fs.existsSync(destination)) fs.rmSync(temporary, { force: true });
        else throw error;
      }
    }

    return {
      id: randomUUID(),
      sha256,
      relativePath,
      originalName: path.basename(originalName),
      mediaType,
      byteLength: buffer.byteLength,
    };
  }
}
