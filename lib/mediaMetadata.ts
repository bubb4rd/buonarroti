import { writeFile, readFile, unlink, mkdtemp, rmdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** Copy `inputPath` to `outputPath` with all container metadata tags removed (ffmpeg, no re-encode). */
export async function stripVideoMetadataFile(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-i", inputPath, "-map_metadata", "-1", "-c", "copy", "-y", outputPath]);
}

/** Strip EXIF/IPTC/XMP (images) or metadata tags (video) from a buffer before storage. */
export async function stripMetadata(buffer: Buffer, contentType: string): Promise<Buffer> {
  if (contentType.startsWith("image/")) {
    return sharp(buffer).toBuffer();
  }
  if (contentType.startsWith("video/")) {
    const extension = contentType.includes("webm") ? "webm" : "mp4";
    const tmpDir = await mkdtemp(join(tmpdir(), "strip-meta-"));
    const inputPath  = join(tmpDir, `input.${extension}`);
    const outputPath = join(tmpDir, `output.${extension}`);
    try {
      await writeFile(inputPath, buffer);
      await stripVideoMetadataFile(inputPath, outputPath);
      return await readFile(outputPath);
    } finally {
      await Promise.all([
        unlink(inputPath).catch(() => {}),
        unlink(outputPath).catch(() => {}),
      ]);
      await rmdir(tmpDir).catch(() => {});
    }
  }
  return buffer;
}
