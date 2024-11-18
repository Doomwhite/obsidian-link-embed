import axios from "axios";
import * as fs from "fs-extra";
import * as path from "path";
import crypto from "crypto";

class ImageDownloader {
  private readonly tempPath: string;

  constructor(tempPath: string) {
    this.tempPath = tempPath;
  }

  async downloadImage(url: string, finalPath: string): Promise<string> {
    console.log("Starting image download...");

    try {
      // Step 1: Download the image to the temporary path
      const contentType = await this.downloadToTempFile(url);
      const extension = this.getExtensionFromContentType(contentType);
      console.log(`Image downloaded with extension: ${extension}`);

      // Step 2: Generate a hash-based filename
      const fileHash = await ImageDownloader.computeFileHash(this.tempPath);
      const finalFileName = `${fileHash}.${extension}`;
      console.log(`Final file name: ${finalFileName}`);

      // Step 3: Move the file to its final destination
      const finalFilePath = await this.moveToFinalPath(finalPath, finalFileName);
      console.log(`File saved to: ${finalFilePath}`);

      return finalFileName;
    } catch (error) {
      console.error("Error during image processing:", error);
      await fs.remove(this.tempPath); // Cleanup temp file on error
      throw error;
    }
  }

  /**
   * Downloads an image from a URL to a temporary file.
   * @returns The Content-Type header of the response.
   */
  private async downloadToTempFile(url: string): Promise<string> {
    console.log("Downloading image from:", url);

    const response = await axios.get(url, { responseType: 'arraybuffer' });
    console.log('response.data', response.data);

    // Write the buffer directly to a temporary file
    await fs.ensureFile(this.tempPath);

    fs.writeFileSync(this.tempPath, Buffer.from(response.data), { encoding: 'binary' });
    console.log("Image saved to temp path:", this.tempPath);

    // Return the content type
    return response.headers["content-type"] || "application/octet-stream";
  }

  /**
   * Determines the file extension from the Content-Type header.
   */
  private getExtensionFromContentType(contentType: string): string {
    const extension = contentType.split("/")[1] || "jpg"; // Default to jpg
    return extension;
  }

  /**
   * Computes a hash of a file's contents.
   */
  private static async computeFileHash(filePath: string): Promise<string> {
    console.log("Computing file hash...");
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(fileBuffer).digest("hex");
  }

  /**
   * Moves a file from a temporary location to its final destination.
   */
  private async moveToFinalPath(finalPath: string, fileName: string): Promise<string> {
    console.log("Moving file to final destination...");

    const finalFilePath = path.join(finalPath, fileName);

    // Ensure the directory exists and move the file
    await fs.ensureDir(path.dirname(finalFilePath));
    await fs.move(this.tempPath, finalFilePath, { overwrite: true });

    return finalFilePath;
  }
}

export default ImageDownloader;