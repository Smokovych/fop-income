#!/bin/sh
# Збирає бібліотеку КЕП для браузера → standalone/vendor/kep.bundle.js
# Потрібні esbuild і вихідні коди бібліотек (git), складені в каталог node_modules поруч із kep-entry.js:
#   dstucrypt/jkurwa@a22e206 (1.23.2, BSD)      dstucrypt/gost89@b7a89b8 (0.1.12, BSD)
#   muromec/asn1.js@7ca2c33 (5.4.1, MIT)        indutny/bn.js@eb2e57c (5.2.5, MIT)
#   feross/buffer@d02bd0a (6.0.3, MIT)          beatgammit/base64-js@303e813 (1.5.1, MIT)
#   feross/ieee754@8a0041f (1.2.1, BSD-3)       isaacs/inherits@b10941c (2.0.4, BlueOak-1.0.0)
#   calvinmetcalf/minimalistic-assert@3311339 (1.0.1, ISC)  ChALkeR/safer-buffer@ed7f4fb (2.1.2, MIT)
#   dstucrypt/jksreader@24671cc (1.0.0, BSD)    emn178/js-sha1@5c5ec87 (0.7.0, MIT)
# fs, node:crypto і js-lzma у браузері не потрібні — замінюються порожніми модулями; глобальний Buffer — поліфіл buffer.
set -e
cd "$(dirname "$0")"
mkdir -p stubs
echo 'export default {};' > stubs/empty.js
echo 'export default { Decoder: function () { throw new Error("LZMA не підтримується"); } };' > stubs/lzma.js
# частина модулів jkurwa (cmp, ctx, Certificate) звертається до глобального Buffer — підставляємо поліфіл
echo 'export { Buffer } from "buffer";' > stubs/buffer-shim.js
esbuild kep-entry.js --bundle --preserve-symlinks --format=iife --global-name=FopKep --platform=browser --target=es2019 --minify \
  --alias:fs=./stubs/empty.js --alias:js-lzma=./stubs/lzma.js --alias:node:crypto=./stubs/empty.js --define:global=globalThis --inject:./stubs/buffer-shim.js \
  --banner:js="/* FopKep: jkurwa 1.23.2, gost89 0.1.12 (BSD, © Ilya Petrov / dstucrypt), asn1.js, bn.js, buffer, base64-js, safer-buffer, js-sha1 (MIT), ieee754 (BSD-3), inherits (BlueOak-1.0.0), minimalistic-assert (ISC), jksreader (BSD). Зібрано standalone/vendor/build-kep.sh */" \
  --outfile=kep.bundle.js
rm -rf stubs
