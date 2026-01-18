# Splat Temporal Compression

Node.js pipeline to convert `.ply` point clouds into unbundled SOG outputs, rearrange WebP attribute frames, and encode WebM videos per attribute.

## Requirements

- Node.js 18+
- `ffmpeg` installed and available on your PATH

## Submodule setup

This repo uses a forked `splat-transform` as a git submodule at `vendor/splat-transform`.

```bash
git submodule update --init --recursive
```

If you make changes in the fork, run its build to refresh `dist/`:

```bash
cd vendor/splat-transform && npm install && npm run build
```

## Install

```bash
npm install
```

## Usage

```bash
npm start -- --input ./input/test1 --output ./output/test1
```

To only run the video encoding step from existing sequences:

```bash
npm run videos -- --output ./output/test1
```

When using `--videos-only`, the manifest is regenerated from existing `output/sog/*/meta.json` files.

This pipeline calls `splat-transform` with positional input/output, writing unbundled SOG to `sog/<name>/meta.json`.
By default it uses `vendor/splat-transform/bin/cli.mjs` if present.

Options:

- `--splat-exec <path>`: path to `splat-transform` executable
- `--splat-args <args...>`: extra args passed to `splat-transform` (default: none)
- `--webp-width <number>`: force SOG WebP width (requires forked splat-transform)
- `--webp-height <number>`: force SOG WebP height (requires forked splat-transform)
- `--crf <number>`: VP9 CRF quality (lower is higher quality; default 18)
- `--gop <number>`: keyframe interval (GOP size)
- `--fps <number>`: output video frame rate
- `--overwrite`: allow existing output subfolders

If ffmpeg cannot decode WebP frames, the pipeline will fall back to `dwebp` (from libwebp) to convert to PNG before encoding.

## Output structure

```
output/
  sog/            # per-.ply unbundled SOG outputs (original WebP preserved)
  sequences/      # per-attribute frame sequences (WebP copies)
  videos/         # per-attribute WebM + manifest.json bundle
```
