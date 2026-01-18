#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';

const program = new Command();

program
  .name('splat-temporal')
  .description('Convert .ply files to SOG, rearrange WebP sequences, and encode WebM videos')
  .option('-i, --input <dir>', 'Input directory containing .ply files')
  .requiredOption('-o, --output <dir>', 'Output directory for SOG, sequences, and videos')
  .option('--splat-exec <path>', 'splat-transform executable', defaultSplatExec())
  .option('--splat-args <args...>', 'Extra args passed to splat-transform', [])
  .option('--webp-width <number>', 'Force WebP width for SOG outputs', parsePositiveInteger)
  .option('--webp-height <number>', 'Force WebP height for SOG outputs', parsePositiveInteger)
  .option('--crf <number>', 'VP9 CRF quality (lower is better)', parseNumber, 18)
  .option('--gop <number>', 'Keyframe interval (GOP size)', parseNumber, 30)
  .option('--fps <number>', 'Frame rate for output videos', parseNumber, 30)
  .option('--overwrite', 'Overwrite existing output directories', false)
  .option('--videos-only', 'Only encode videos from existing sequences', false)
  .parse(process.argv);

const options = program.opts();

function parseNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value) {
  const parsed = parseNumber(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function defaultSplatExec() {
  const localPath = path.resolve('vendor', 'splat-transform', 'bin', 'cli.mjs');
  return existsSync(localPath) ? localPath : 'splat-transform';
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listPlyFiles(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ply'))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function uniqueDir(baseDir) {
  let candidate = baseDir;
  let suffix = 1;
  while (await pathExists(candidate)) {
    candidate = `${baseDir}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function runSplatTransform({ execPath, args, inputPath, outputPath }) {
  const fullArgs = [...args, inputPath, outputPath];
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, fullArgs, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`splat-transform failed with exit code ${code}`));
      }
    });
  });
}

function findExecutable(name) {
  const pathParts = (process.env.PATH || '').split(path.delimiter);
  for (const part of pathParts) {
    const candidate = path.join(part, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function walkForWebp(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkForWebp(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.webp')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function convertSequenceToPng({ sequenceDir, pngDir, dwebpPath }) {
  await ensureDir(pngDir);
  const frameFiles = await listSequenceFrames(sequenceDir);
  for (const fileName of frameFiles) {
    const srcPath = path.join(sequenceDir, fileName);
    const targetPath = path.join(pngDir, fileName.replace(/\.webp$/i, '.png'));
    await new Promise((resolve, reject) => {
      const child = spawn(dwebpPath, [srcPath, '-o', targetPath], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`dwebp failed with exit code ${code}`));
        }
      });
    });
  }
}

async function listSequenceDirs(sequenceRoot) {
  const entries = await fs.readdir(sequenceRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listSogDirs(sogRoot) {
  const entries = await fs.readdir(sogRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listSequenceFrames(sequenceDir) {
  const entries = await fs.readdir(sequenceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.webp'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function mapMetaToWebm(meta) {
  const cloned = JSON.parse(JSON.stringify(meta));
  const targets = ['means', 'scales', 'quats', 'sh0', 'shN'];
  for (const key of targets) {
    if (!cloned[key] || !Array.isArray(cloned[key].files)) {
      continue;
    }
    cloned[key].files = cloned[key].files.map((fileName) =>
      fileName.replace(/\.webp$/i, '.webm')
    );
  }
  return cloned;
}

async function encodeWithFfmpeg({ inputPattern, outputVideoPath, fps, crf, gop }) {
  const filterGraph =
    'color=black@1.0:size=16x16[bg];' +
    '[0:v]format=rgba[fg];' +
    '[bg][fg]scale2ref[bg2][fg2];' +
    '[bg2][fg2]overlay=shortest=1:format=auto[outv]';
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPattern)
      .inputOptions(['-framerate', String(fps), '-start_number', '0'])
      .complexFilter(filterGraph, 'outv')
      .outputOptions([
        '-c:v libvpx-vp9',
        '-b:v 0',
        `-crf ${crf}`,
        `-g ${gop}`,
        '-pix_fmt yuv420p',
        '-an'
      ])
      .output(outputVideoPath)
      .on('error', reject)
      .on('end', resolve)
      .run();
  });
}

async function encodeSequenceToWebm({ sequenceDir, outputVideoPath, fps, crf, gop, dwebpPath }) {
  const webpPattern = path.join(sequenceDir, 'frame_%05d.webp');
  try {
    await encodeWithFfmpeg({
      inputPattern: webpPattern,
      outputVideoPath,
      fps,
      crf,
      gop
    });
    return;
  } catch (error) {
    if (!dwebpPath) {
      throw error;
    }
  }

  console.warn(`ffmpeg could not decode WebP in ${sequenceDir}; falling back to dwebp + PNG.`);

  const pngDir = path.join(sequenceDir, '_png');
  await convertSequenceToPng({ sequenceDir, pngDir, dwebpPath });

  const pngPattern = path.join(pngDir, 'frame_%05d.png');
  await encodeWithFfmpeg({
    inputPattern: pngPattern,
    outputVideoPath,
    fps,
    crf,
    gop
  });
}

async function main() {
  const inputDir = options.input ? path.resolve(options.input) : null;
  const outputDir = path.resolve(options.output);

  if (!options.videosOnly) {
    if (!inputDir) {
      throw new Error('Input directory is required unless --videos-only is set');
    }
    if (!(await pathExists(inputDir))) {
      throw new Error(`Input directory not found: ${inputDir}`);
    }
  }

  await ensureDir(outputDir);

  const sogRoot = path.join(outputDir, 'sog');
  const sequenceRoot = path.join(outputDir, 'sequences');
  const videoRoot = path.join(outputDir, 'videos');

  if (!options.videosOnly && !options.overwrite) {
    for (const dir of [sogRoot, sequenceRoot, videoRoot]) {
      if (await pathExists(dir)) {
        throw new Error(`Output subfolder already exists: ${dir} (use --overwrite to allow)`);
      }
    }
  } else if (!options.videosOnly) {
    for (const dir of [sogRoot, sequenceRoot, videoRoot]) {
      if (await pathExists(dir)) {
        await removeDir(dir);
      }
    }
  }

  await ensureDir(sogRoot);
  await ensureDir(sequenceRoot);
  await ensureDir(videoRoot);

  const dwebpPath = findExecutable('dwebp');

  const splatArgs = [...options.splatArgs];
  if (options.webpWidth !== undefined) {
    splatArgs.push('--webp-width', String(options.webpWidth));
  }
  if (options.webpHeight !== undefined) {
    splatArgs.push('--webp-height', String(options.webpHeight));
  }
  const processed = [];
  if (!options.videosOnly) {
    const plyFiles = await listPlyFiles(inputDir);
    if (plyFiles.length === 0) {
      throw new Error(`No .ply files found in ${inputDir}`);
    }

    for (const plyPath of plyFiles) {
      const baseName = path.basename(plyPath, path.extname(plyPath));
      const desiredDir = path.join(sogRoot, baseName);
      const outputSogDir = await uniqueDir(desiredDir);
      await ensureDir(outputSogDir);
      const outputMetaPath = path.join(outputSogDir, 'meta.json');

      await runSplatTransform({
        execPath: options.splatExec,
        args: splatArgs,
        inputPath: plyPath,
        outputPath: outputMetaPath
      });

      processed.push({
        plyPath,
        plyName: path.basename(plyPath),
        sogDir: outputSogDir
      });
    }
  }

  const frameCounters = new Map();
  const splatFrames = new Map();

  if (!options.videosOnly) {
    for (const item of processed) {
      const webps = await walkForWebp(item.sogDir);
      for (const webpPath of webps) {
        const sequenceName = path.basename(webpPath, path.extname(webpPath));
        const sequenceDir = path.join(sequenceRoot, sequenceName);
        await ensureDir(sequenceDir);

        const currentIndex = frameCounters.get(sequenceName) ?? 0;
        frameCounters.set(sequenceName, currentIndex + 1);

        const frameName = `frame_${String(currentIndex).padStart(5, '0')}.webp`;
        const targetPath = path.join(sequenceDir, frameName);

        await fs.copyFile(webpPath, targetPath);

        if (!splatFrames.has(item.plyName)) {
          splatFrames.set(item.plyName, currentIndex);
        } else if (splatFrames.get(item.plyName) !== currentIndex) {
          console.warn(
            `Frame index mismatch for ${item.plyName}: ` +
              `saw ${currentIndex}, expected ${splatFrames.get(item.plyName)}`
          );
        }
      }
    }
  }

  const sequenceNames = (await listSequenceDirs(sequenceRoot)).sort((a, b) => a.localeCompare(b));
  for (const sequenceName of sequenceNames) {
    const sequenceDir = path.join(sequenceRoot, sequenceName);
    const frameFiles = await listSequenceFrames(sequenceDir);
    if (frameFiles.length === 0) {
      continue;
    }

    const outputVideoPath = path.join(videoRoot, `${sequenceName}.webm`);

    await encodeSequenceToWebm({
      sequenceDir,
      outputVideoPath,
      fps: options.fps,
      crf: options.crf,
      gop: options.gop,
      dwebpPath
    });
  }

  if (!options.videosOnly) {
    const splats = [];
    for (const item of processed) {
      const metaPath = path.join(item.sogDir, 'meta.json');
      const metaRaw = await fs.readFile(metaPath, 'utf8');
      const frameIndex = splatFrames.get(item.plyName);
      splats.push({
        original: item.plyName,
        frame: frameIndex ?? null,
        meta: mapMetaToWebm(JSON.parse(metaRaw))
      });
    }

    const manifest = {
      splats
    };

    const manifestPath = path.join(videoRoot, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    console.log(`Processed ${processed.length} .ply files.`);
    console.log(`Sequences written to ${sequenceRoot}`);
  } else {
    const splats = [];
    if (await pathExists(sogRoot)) {
      const sogDirs = (await listSogDirs(sogRoot)).sort((a, b) => a.localeCompare(b));
      for (let index = 0; index < sogDirs.length; index += 1) {
        const dirName = sogDirs[index];
        const metaPath = path.join(sogRoot, dirName, 'meta.json');
        if (!(await pathExists(metaPath))) {
          continue;
        }
        const metaRaw = await fs.readFile(metaPath, 'utf8');
        splats.push({
          original: `${dirName}.ply`,
          frame: index,
          meta: mapMetaToWebm(JSON.parse(metaRaw))
        });
      }
    }

    const manifest = {
      splats
    };

    const manifestPath = path.join(videoRoot, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  console.log(`Videos written to ${videoRoot}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
