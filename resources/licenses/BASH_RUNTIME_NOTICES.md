# Sandboxed Bash runtime notices

Mental LEGOs can optionally download a sandboxed Bash runtime on Windows.
The runtime is not stored in this source repository or bundled into the
application installer. Installation is an explicit user action. Every asset is
downloaded directly from its upstream publisher and verified against the exact
size and SHA-256 digest recorded in the public runtime manifest.

The native `MentalLegos.BashProxy.exe` bridge is compiled with Zig 0.16.0.
Zig is licensed under the MIT License; see `ZIG_LICENSE.txt` in this directory.

## Wasmer

- Version: 7.2.1
- Project and source: https://github.com/wasmerio/wasmer
- Release: https://github.com/wasmerio/wasmer/releases/tag/v7.2.1
- License: MIT

The upstream `LICENSE` and `ATTRIBUTIONS` files are retained with every local
installation.

## GNU Bash WebC

- Registry package: `wasmer/bash@1.0.25`
- Package page: https://wasmer.io/wasmer/bash
- Runtime-reported license: GPLv3+
- GNU Bash project and source: https://www.gnu.org/software/bash/

The Bash WebC is fetched directly from Wasmer's content-addressed CDN. Mental
LEGOs does not redistribute or modify this artifact. The installed Bash runtime
reports its own copyright and GPLv3-or-later notice through `bash --version`.

## Coreutils WebC

- Registry package: `wasmer/coreutils@1.0.25`
- Package page: https://wasmer.io/wasmer/coreutils
- Registry-reported license: MIT

These components are third-party software and are not Mental LEGOs models or
application code.
