# LabLock Examination System

This branch adds a Next.js 16 examination application alongside the existing Python implementation in lablock_final/. The original Python files and model are retained.

## Local setup

- Install Bun and Node.js 20.9 or newer.
- Run `bun install`.
- Configure `FACULTY_PIN_HASH` in the environment to the SHA-256 hex digest of your faculty key. Generate it with `printf %s 'YourKey' | sha256sum`.
- Run `bun run db:push`.
- Run `bun run dev` and open http://localhost:3000.

The demo candidate access PIN is 2468.

## Required offline model assets

The application expects the COCO-SSD lite_mobilenet_v2 model at public/models/coco-ssd/model.json with its five group1-shard weight files. It also expects the MediaPipe FaceMesh UMD and wasm/data assets under public/mediapipe/face_mesh/. These large upstream model/runtime binaries are not fabricated or replaced with placeholders in this commit. Until they are added, browser inference will report a missing-model error; webcam access itself can still initialize.

## Security note

The demo candidate PIN is intentionally specified by the supplied task. Set a unique FACULTY_PIN_HASH before exposing the application to a network. This is a development implementation and has not yet undergone a production security review.
