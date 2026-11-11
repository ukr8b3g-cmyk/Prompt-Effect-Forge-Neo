# Sources and asset provenance

Prompt Effect uses the catalog, original effect/Boost text and 176 unchanged thumbnail files from [Krea2-BBOX-Prompter](https://github.com/ukr8b3g-cmyk/Krea2-BBOX-Prompter), commit `7f6b61d151d52ba980bd5d92ec094cba52f4a633`.

The UI mounting pattern, natural-language insertion boundary rules and original-host communication design were informed by [Background-Prompter](https://github.com/ukr8b3g-cmyk/Background-Prompter), commit `da8448b31c85ea98aaa31425536bfa0f6743d9b6`. The catalog is independent of its 592 backgrounds.

Original MIT license notices and the Background notice are retained in `provenance/`. `provenance/asset_manifest.json` records each thumbnail's original URL, SHA-256, Git blob SHA, byte size and dimensions. The source repositories do not declare separate per-image terms in the inspected files; this extension does not invent or replace those terms.

New extension code is licensed under the MIT license in `LICENSE`. The 176 images are selection previews, not generation reference inputs. There is no network download or model-specific prompt conversion at runtime.
