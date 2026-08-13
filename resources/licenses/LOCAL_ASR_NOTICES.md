# Local speech recognition notices

Mental LEGOs uses the following third-party components for its optional,
on-device speech recognition feature.

## sherpa-onnx runtime

- Components: `sherpa-onnx-node` and `sherpa-onnx-win-x64`
- Version: 1.13.4
- Project: https://github.com/k2-fsa/sherpa-onnx
- License: Apache License 2.0; see `Apache-2.0.txt` in this directory.

## SenseVoiceSmall model weights

- Model name retained for attribution: SenseVoiceSmall
- Model project: https://github.com/FunAudioLLM/SenseVoice
- Converted model distribution: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- Governing terms: FunASR Model Open Source License Agreement referenced by
  the model distribution and official model card.
- Commercial/local-use clarification from the model maintainer:
  https://github.com/FunAudioLLM/SenseVoice/issues/286

The model weights are not stored in this source repository. Any model
installer built from the accompanying manifest must preserve the license
reference shipped in the archive and expose this attribution to the user.
The model must not be presented as a Mental LEGOs model.
