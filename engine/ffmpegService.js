const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * FlowStudio Lite — FFmpeg helpers (adapted from V2).
 *
 * AUDIT FIX: getVideoDimensions() must NEVER silently invent a resolution.
 * V2 resolved { width: 1080, height: 1920 } whenever ffprobe failed, which
 * made corrupt/truncated downloads look valid and fed wrong geometry into
 * watermark math. Lite resolves NULL on any probe failure and callers must
 * treat null as "dimensions unknown" (an error for dimension-dependent
 * operations).
 *
 * In Lite the service is used to VALIDATE downloaded videos: a saved file
 * whose dimensions cannot be probed is treated as a failed download.
 */
class FFmpegService {
  static async stitchVideos(videoPaths, outputPath, onProgress = () => {}) {
    if (!videoPaths || videoPaths.length === 0) {
      throw new Error('No video files provided for stitching.');
    }

    const validPaths = videoPaths.filter(p => fs.existsSync(p));
    if (validPaths.length === 0) {
      throw new Error('None of the provided video files exist on disk.');
    }

    if (validPaths.length === 1) {
      fs.copyFileSync(validPaths[0], outputPath);
      return outputPath;
    }

    const tempDir = os.tmpdir();
    const concatListPath = path.join(tempDir, `flow_stitch_${Date.now()}.txt`);
    const fileLines = validPaths.map(p => {
      const escaped = p.replace(/\\/g, '/').replace(/'/g, "'\\''");
      return `file '${escaped}'`;
    }).join('\n');
    fs.writeFileSync(concatListPath, fileLines, 'utf8');

    try {
      const copyArgs = [
        '-f', 'concat', '-safe', '0', '-i', concatListPath,
        '-c', 'copy', '-movflags', '+faststart', '-y', outputPath
      ];

      try {
        await this._runFFmpeg(copyArgs, onProgress);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          return outputPath;
        }
      } catch (copyErr) {
        console.warn('[FFmpeg Copy failed, falling back to clean re-encode]:', copyErr.message);
      }

      const reencodeArgs = [
        '-f', 'concat', '-safe', '0', '-i', concatListPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', '-y', outputPath
      ];

      await this._runFFmpeg(reencodeArgs, onProgress);

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
        throw new Error('Stitching failed: Output file was not generated.');
      }

      return outputPath;
    } finally {
      if (fs.existsSync(concatListPath)) {
        try { fs.unlinkSync(concatListPath); } catch (e) {}
      }
    }
  }

  static async stripMetadata(inputPath, outputPath = null) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const targetOutput = outputPath || inputPath.replace(/\.mp4$/i, '_clean.mp4');
    const isSameFile = (targetOutput === inputPath);
    const actualOutput = isSameFile ? inputPath.replace(/\.mp4$/i, `_tmp_${Date.now()}.mp4`) : targetOutput;

    const args = [
      '-i', inputPath,
      '-map_metadata', '-1',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      actualOutput
    ];

    try {
      await this._runFFmpeg(args);
      if (isSameFile) {
        fs.unlinkSync(inputPath);
        fs.renameSync(actualOutput, inputPath);
        return inputPath;
      }
      return targetOutput;
    } catch (err) {
      if (isSameFile && fs.existsSync(actualOutput)) {
        try { fs.unlinkSync(actualOutput); } catch (e) {}
      }
      throw err;
    }
  }

  static getFFmpegPath() {
    if (this._cachedFFmpegPath && (this._cachedFFmpegPath === 'ffmpeg' || fs.existsSync(this._cachedFFmpegPath))) {
      return this._cachedFFmpegPath;
    }

    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) {
      const wingetBase = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(wingetBase)) {
        try {
          const dirs = fs.readdirSync(wingetBase);
          for (const d of dirs) {
            if (d.toLowerCase().includes('ffmpeg')) {
              const dirPath = path.join(wingetBase, d);
              const subdirs = fs.readdirSync(dirPath);
              for (const sub of subdirs) {
                const bin = path.join(dirPath, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(bin)) {
                  this._cachedFFmpegPath = bin;
                  return bin;
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
      '/usr/bin/ffmpeg'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this._cachedFFmpegPath = c;
        return c;
      }
    }

    this._cachedFFmpegPath = 'ffmpeg';
    return 'ffmpeg';
  }

  static getFFprobePath() {
    if (this._cachedFFprobePath && (this._cachedFFprobePath === 'ffprobe' || fs.existsSync(this._cachedFFprobePath))) {
      return this._cachedFFprobePath;
    }

    const ffmpegPath = this.getFFmpegPath();
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
      const probeCandidate = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      if (fs.existsSync(probeCandidate)) {
        this._cachedFFprobePath = probeCandidate;
        return probeCandidate;
      }
    }
    if (fs.existsSync('/usr/bin/ffprobe')) {
      this._cachedFFprobePath = '/usr/bin/ffprobe';
      return '/usr/bin/ffprobe';
    }

    this._cachedFFprobePath = 'ffprobe';
    return 'ffprobe';
  }

  static get ffmpegPath() {
    return this.getFFmpegPath();
  }

  get ffmpegPath() {
    return FFmpegService.getFFmpegPath();
  }

  /**
   * Probes video dimensions via ffprobe.
   * Resolves { width, height } on success, or NULL when the probe fails or
   * the output is unparseable — never a fabricated default (audit fix).
   */
  static async getVideoDimensions(inputPath) {
    const probeBin = this.getFFprobePath();
    return new Promise((resolve) => {
      execFile(probeBin, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0',
        inputPath
      ], { windowsHide: true }, (err, stdout) => {
        if (!err && stdout) {
          const parts = stdout.trim().split('x');
          if (parts.length === 2) {
            const w = parseInt(parts[0], 10);
            const h = parseInt(parts[1], 10);
            if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) {
              return resolve({ width: w, height: h });
            }
          }
        }
        resolve(null);
      });
    });
  }

  /**
   * Download validation used by the automation engine: returns true when
   * the file exists and (if ffprobe is available) has probeable video
   * dimensions. When ffprobe is unavailable the check degrades to a
   * size/existence check so machines without FFmpeg still work.
   */
  static async verifyVideoFile(filePath, minBytes = 20000) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stats = fs.statSync(filePath);
      if (stats.size < minBytes) return false;
      const probeAvailable = await this.isProbeAvailable();
      if (!probeAvailable) return true;
      const dims = await this.getVideoDimensions(filePath);
      return dims !== null;
    } catch (e) {
      return false;
    }
  }

  static async isAvailable() {
    const bin = this.getFFmpegPath();
    return new Promise((resolve) => {
      execFile(bin, ['-version'], { windowsHide: true }, (error) => {
        resolve(!error);
      });
    });
  }

  static async isProbeAvailable() {
    const bin = this.getFFprobePath();
    return new Promise((resolve) => {
      execFile(bin, ['-version'], { windowsHide: true }, (error) => {
        resolve(!error);
      });
    });
  }

  static _runFFmpeg(args, onProgress = () => {}) {
    const bin = this.getFFmpegPath();
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { windowsHide: true });
      let stderr = '';

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 100 * 1024) {
          stderr = stderr.slice(-50 * 1024);
        }
        const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (match) {
          onProgress({ time: match[1] });
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}

module.exports = { FFmpegService };
