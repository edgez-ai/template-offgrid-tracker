# Firmware licensing and distribution notice

This repository's Apache-2.0 license applies to the original Offgrid Tracker
code. It does not replace the licenses of firmware submodules, prebuilt static
libraries, radio firmware, board-configuration blobs, or other third-party
components.

## Important Morse Micro boundary

The public `edgez-ai/mm-iot-sdk` dependency contains components under several
licenses. In particular, files in `framework/morselib` identify themselves as:

```text
GPL-3.0-or-later OR LicenseRef-MorseMicroCommercial
```

Building firmware locally or in GitHub Actions does not grant a Morse Micro
commercial license. Before distributing, selling, publishing, or otherwise
providing a firmware binary that contains those objects, the distributor must
choose and satisfy an available licensing path:

1. obtain and comply with a commercial license from Morse Micro that covers
   the relevant SDK/driver version and intended distribution (the SDK's
   `LicenseRef-MorseMicroCommercial.txt` directs users to sign through
   [Morse Micro](https://www.morsemicro.com/)); or
2. distribute the combined work in compliance with the applicable GNU GPL,
   including the license notices and complete corresponding source required
   for the exact binary being provided.

Merely linking to a newer or different source tree is not a substitute for
providing the corresponding source for the distributed binary. Consult the
file-level notices and `LICENSES/GPL-3.0-or-later.txt` in the pinned
`mm-iot-sdk` checkout. Obtain legal advice for the intended product and
distribution model.

## EdgeZ Mesh and adapter licensing

- `edgez-rf-api` and `edgez-rf-morsemicro` are Apache-2.0 components.
- The EdgeZ Mesh prebuilt archives and public headers are governed by the
  `EDGEZERON-COMMERCIAL-LICENSE` shipped beside each archive. That license
  permits its stated non-commercial and internal-evaluation uses; commercial
  use requires a separate written license from EdgeZeron AI AB.
- The EdgeZ Mesh package's `THIRD-PARTY-NOTICES`, Apache-2.0 text, and
  BSD-3-Clause text must remain with any permitted redistribution.
- Morse Micro chip firmware and BCF files remain governed by their vendor
  Binary Distribution License. That license permits only its stated uses and
  requires the license to accompany distribution. The build obtains BCF files
  from the pinned `mm-iot-sdk` checkout rather than treating them as
  EdgeZ-owned material.

The adapter layer does not relicense the vendor SDK. The portable EdgeZ Mesh
core must depend only on `edgez-rf-api`; Morse-specific types and driver calls
belong in `edgez-rf-morsemicro` or the separately licensed vendor layer.

## Repository release policy

This template does not attach firmware binaries (`.bin`, `.hex`, `.uf2`, or
`.elf`) to GitHub Releases. The manual **Build firmware** workflow compiles the
selected PlatformIO targets and stores short-lived GitHub Actions artifacts
for testing. Those artifacts include this notice, applicable license texts,
and an exact source revision manifest.

An Actions artifact is still a copy of the firmware. Anyone who shares or
otherwise distributes it remains responsible for satisfying all applicable
licenses. A separate product/deployment repository may publish firmware only
after its distributor has established the required EdgeZ and Morse Micro
license path and implemented the corresponding notice/source obligations.
