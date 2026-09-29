# lilLED R1 Interaction Lab — 0.3.0

This is a **stock RabbitOS Creation**, not ESP32 firmware and not a custom R1 ROM. Rev C focuses on the physical/input behavior behind the supplied lilLED suite rather than only visual resemblance.

## Core and LABS

Core order is exact: Rain, HSV, AEM, Synth, Percussion, Recorder, uDAQ, Settings, Transfer, Communications, WhoFi.

LABS contains separate reference owners: lilMIDI, Particles, Notebook, Power, Camera.

## Shared interaction services

- SensorHub — one calibrated motion stream for every motion app.
- InteractionRouter — pointer ownership for high-rate touch/gesture surfaces.
- NavigationGuard — protects recording/capture/stream states from accidental app exit.
- PatternService — one shared Transfer/Communications pattern and lockout.
- MediaRepository — persistent local recordings/images when IndexedDB is available.
- TransportManager — explicit optional host WebSocket state.

See `../../docs/ARCHITECTURE.md` and `../../docs/R1_INPUT_MAPPING.md`.

## Defining Rev C behaviors

### Rain
IMU roll/pitch affects effective simulation values while wheel edits persistent baselines. Manual mode disables motion influence.

### HSV
IMU mode maps calibrated device attitude to the cone slice plane. Drag the cone to orbit it, touch the section to choose color, then sample/store the swatch. Wheel fine-adjusts the selected plane parameter.

### AEM
Motion changes effective load/water without altering baseline configuration. Shake can trigger temporary degas. Driver/load/water/efficiency/membrane controls remain explicit.

### Synth
Captured XY touch drives Web Audio. Motion can modulate arp/effect behavior. Map and Sound pages retain continuous parameters. Side hold gates the current voice when supported by the Rabbit bridge.

### Percussion
The primary interaction is whole-kit XY contact/re-touch: 650 ms grace after release, first 180 ms of re-touch movement chooses directional variation, and no re-touch stops at a loop boundary. The 16-step editor is intentionally labeled **R1 EXTENSION / Pattern Inspector**.

### Recorder
Real mic/MediaRecorder path when exposed. Review/seek/save/discard are functional. Saved clips use MediaRepository and reload by ID. Saved voice media can be staged into Communications. Dirty/recording states guard navigation.

### uDAQ / Settings
uDAQ is the evidence path for the shared motion service: 5/10/25 Hz, 300-record ring and CSV export. Settings owns Motion Lab and neutral centering.

### Transfer / Communications
Both share one pattern credential and relock when left. Transfer shows Creation-local media and optional host-provider truth. Communications uses wheel-based character selection, local receipts and a separately labeled Rabbit bridge probe.

### WhoFi
The richer source interaction model is preserved, but the bundled CSI provider is **SIMULATED**. Raw native CSI remains unavailable to a normal Creation and is never presented as R1 live data.

## LABS

- lilMIDI: configurable XY mapping/scenes/review with optional WebSocket host messages.
- Particles: movable orbit target and source-oriented physics/particle/display controls.
- Notebook: seven utilities surfaced; Home is touch- and wheel-operable.
- Power: real Battery Status API only if exposed.
- Camera: browser camera capture/review/save with unsaved-capture navigation guard.

## Build

From workspace root:

```text
VALIDATE.bat lilled-r1
REFERENCE_AUDIT.bat C:\path\to\extracted\LED
BUILD.bat lilled-r1
```

Then host `dist/lilled-r1/` on HTTPS and prepare install metadata with `PREPARE_INSTALL.bat`.

## Acceptance boundary

Automated tests prove deterministic code paths; they do **not** establish physical R1 axis polarity, sensor rate, wheel direction, side-hold event timing, audio latency, mic/camera permissions or WebView persistence. Those are tracked in `../../docs/R1_DEVICE_VALIDATION.md`.
