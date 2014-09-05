/*
 * Rusha, a JavaScript implementation of the Secure Hash Algorithm, SHA-1,
 * as defined in FIPS PUB 180-1, tuned for high performance with large inputs.
 * (http://github.com/srijs/rusha)
 *
 * Inspired by Paul Johnstons implementation (http://pajhome.org.uk/crypt/md5).
 *
 * Copyright (c) 2013 Sam Rijs (http://awesam.de).
 * Released under the terms of the MIT license as follows:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

(function () {

  // If we'e running in Node.JS, export a module.
  if (typeof module !== 'undefined') {
    module.exports = Rusha;
  }

  // If we're running in a DOM context, export
  // the Rusha object to toplevel.
  if (typeof window !== 'undefined') {
    window.Rusha = Rusha;
  }

  // If we're running in a webworker, accept
  // messages containing a jobid and a buffer
  // or blob object, and return the hash result.
  if (typeof FileReaderSync !== 'undefined') {
    var reader = new FileReaderSync(),
        hasher = new Rusha(4 * 1024 * 1024);
    self.onmessage = function onMessage (event) {
      var hash, data = event.data.data;
      if (data instanceof Blob) {
        try {
          data = reader.readAsBinaryString(data);
        } catch (e) {
          self.postMessage({id: event.data.id, error: e.name});
          return;
        }
      }
      hash = hasher.digest(data);
      self.postMessage({id: event.data.id, hash: hash});
    };
  }

  // The Rusha object is a wrapper around the low-level RushaCore.
  // It provides means of converting different inputs to the
  // format accepted by RushaCore as well as other utility methods.
  function Rusha (sizeHint) {
    "use strict";

    // Private object structure.
    var self = {fill: 0};

    // Calculate the length of buffer that the sha1 routine uses
    // including the padding.
    var padlen = function (len) {
      for (len += 9; len % 64 > 0; len += 1);
      return len;
    };

    var padZeroes = function (bin, len) {
      for (var i = len >> 2; i < bin.length; i++) bin[i] = 0;
    };

    var padData = function (bin, len) {
      bin[len>>2] |= 0x80 << (24 - (len % 4 << 3));
      bin[(((len >> 2) + 2) & ~0x0f) + 15] = len << 3;
    };

    // Convert a binary string to a big-endian Int32Array using
    // four characters per slot and pad it per the sha1 spec.
    // A binary string is expected to only contain char codes < 256.
    var convStr = function (str, bin, len) {
      var i;
      for (i = 0; i < len; i = i + 4 |0) {
        bin[i>>2] = str.charCodeAt(i)   << 24 |
                    str.charCodeAt(i+1) << 16 |
                    str.charCodeAt(i+2) <<  8 |
                    str.charCodeAt(i+3);
      }
    };

    // Convert a buffer or array to a big-endian Int32Array using
    // four elements per slot and pad it per the sha1 spec.
    // The buffer or array is expected to only contain elements < 256.
    var convBuf = function (buf, bin, len) {
      var i, m = len % 4, j = len - m;
      for (i = 0; i < j; i = i + 4 |0) {
        bin[i>>2] = buf[i]   << 24 |
                    buf[i+1] << 16 |
                    buf[i+2] <<  8 |
                    buf[i+3];
      }
      switch (m) {
        case 0: bin[j>>2] |= buf[j+3];
        case 3: bin[j>>2] |= buf[j+2] << 8;
        case 2: bin[j>>2] |= buf[j+1] << 16;
        case 1: bin[j>>2] |= buf[j]   << 24;
      }
    };

    // Convert general data to a big-endian Int32Array written on the
    // heap and return it's length;
    var conv = function (data, bin, len) {
      if (typeof data === 'string') {
        return convStr(data, bin, len);
      } else if (data instanceof Array || (typeof global !== 'undefined' &&
                                           typeof global.Buffer !== 'undefined' &&
                                           global.Buffer.isBuffer(data))) {
        return convBuf(data, bin, len);
      } else if (data instanceof ArrayBuffer) {
        return convBuf(new Uint8Array(data), bin, len);
      } else if (data.buffer instanceof ArrayBuffer) {
        return convBuf(new Uint8Array(data.buffer), bin, len);
      } else {
        throw new Error('Unsupported data type.');
      }
    };

    // Convert an ArrayBuffer into its hexadecimal string representation.
    var hex = function (arrayBuffer) {
      var i, x, hex_tab = "0123456789abcdef", res = [], binarray = new Uint8Array(arrayBuffer);
      for (i = 0; i < binarray.length; i++) {
        x = binarray[i];
        res[i] = hex_tab.charAt((x >>  4) & 0xF) +
                 hex_tab.charAt((x >>  0) & 0xF);
      }
      return res.join('');
    };

    var ceilHeapSize = function (v) {
      // The asm.js spec says:
      // The heap object's byteLength must be either
      // 2^n for n in [12, 24) or 2^24 * n for n ≥ 1.
      var p;
      // If v is smaller than 2^12, the smallest possible solution
      // is 2^12.
      if (v <= 4096) return 4096;
      // If v < 2^24, we round up to 2^n,
      // otherwise we round up to 2^24 * n.
      if (v < 16777216) {
        for (p = 1; p < v; p = p << 1);
      } else {
        for (p = 16777216; p < v; p += 16777216);
      }
      return p;
    };

    // Resize the internal data structures to a new capacity.
    var resize = function (size) {
      self.sizeHint = size;
      // The size of the heap is the sum of:
      // 1. The padded input message size
      // 2. The extended space the algorithm needs (320 byte)
      // 3. The 160 bit state the algoritm uses
      self.heap     = new ArrayBuffer(ceilHeapSize(padlen(size) + 320 + 20));
      self.core     = RushaCore({Int32Array: Int32Array, DataView: DataView}, {}, self.heap);
    };

    // On initialize, resize the datastructures according
    // to an optional size hint.
    resize(sizeHint || 0);

    var initState = function (io) {
      io[0] =  1732584193;
      io[1] =  -271733879;
      io[2] = -1732584194;
      io[3] =   271733878;
      io[4] = -1009589776;
    };

    // Initialize and call the RushaCore,
    // assuming an input buffer of length len * 4.
    var coreCall = function (len) {
      self.core.hash(len);
    };

    // Calculate the hash digest as an array of 5 32bit integers.
    var rawDigest = this.rawDigest = function (str) {
      var len = str.byteLength || str.length;
      if (len > self.sizeHint) {
        resize(len);
      }
      var padMsgLen = padlen(len);
      var view = new Int32Array(self.heap, 0, padMsgLen >> 2);
      var io = new Int32Array(self.heap, padMsgLen + 320, 5);
      padZeroes(view, len);
      conv(str, view, len);
      padData(view, len);
      initState(io);
      coreCall(padMsgLen);
      var out = new Int32Array(5);
      var arr = new DataView(out.buffer);
      arr.setInt32(0,  io[0], false);
      arr.setInt32(4,  io[1], false);
      arr.setInt32(8,  io[2], false);
      arr.setInt32(12, io[3], false);
      arr.setInt32(16, io[4], false);
      return out;
    };

    // The digest and digestFrom* interface returns the hash digest
    // as a hex string.
    this.digest = this.digestFromString =
    this.digestFromBuffer = this.digestFromArrayBuffer =
    function (str) {
      return hex(rawDigest(str).buffer);
    };

  };

  macro rol1  { rule { ($v:expr) } => { ($v <<  1 | $v >>> 31) } }
  macro rol5  { rule { ($v:expr) } => { ($v <<  5 | $v >>> 27) } }
  macro rol30 { rule { ($v:expr) } => { ($v << 30 | $v >>>  2) } }

  macro extended {
    rule { ($H, $j:expr) } => {
      rol1($H[$j-12>>2] ^ $H[$j-32>>2] ^ $H[$j-56>>2] ^ $H[$j-64>>2])
    }
  }

  macro F0 { rule { ($b,$c,$d) } => { ($b & $c | ~$b & $d) } }
  macro F1 { rule { ($b,$c,$d) } => { ($b ^ $c ^ $d) }}
  macro F2 { rule { ($b,$c,$d) } => { ($b & $c | $b & $d | $c & $d) }}

  macro swap {
    rule { ($y0, $y1, $y2, $y3, $y4, $t0) } => {
      $y4 = $y3;
      $y3 = $y2;
      $y2 = rol30($y1);
      $y1 = $y0;
      $y0 = $t0;
    }
  }

  macro roundL { rule { ($y0, $f:expr) } => { (rol5($y0) + $f |0) } }
  macro roundR { rule { ($y4, $t1) }     => { ($t1 + $y4 |0) } }

  // The low-level RushCore module provides the heart of Rusha,
  // a high-speed sha1 implementation working on an Int32Array heap.
  // At first glance, the implementation seems complicated, however
  // with the SHA1 spec at hand, it is obvious this almost a textbook
  // implementation that has a few functions hand-inlined and a few loops
  // hand-unrolled.
  function RushaCore (stdlib, foreign, heap) {
    "use asm";

    var H = new stdlib.Int32Array(heap);

    function hash (k) { // k in bytes

      k = k|0;
      var i = 0, j = 0,
          y0 = 0, z0 = 0, y1 = 0, z1 = 0,
          y2 = 0, z2 = 0, y3 = 0, z3 = 0,
          y4 = 0, z4 = 0, t0 = 0, t1 = 0;

      y0 = H[k+320>>2]|0;
      y1 = H[k+324>>2]|0;
      y2 = H[k+328>>2]|0;
      y3 = H[k+332>>2]|0;
      y4 = H[k+336>>2]|0;

      for (i = 0; (i|0) < (k|0); i = i + 64 |0) {

        z0 = y0;
        z1 = y1;
        z2 = y2;
        z3 = y3;
        z4 = y4;

        for (j = 0; (j|0) < 64; j = j + 4 |0) {
          t1 = H[i+j>>2]|0;
          t0 = roundL(y0, F0(y1, y2, y3)) + (roundR(y4, t1) + 1518500249 |0) |0;
          swap(y0, y1, y2, y3, y4, t0);
          H[k+j>>2] = t1;
        }

        for (j = k + 64 |0; (j|0) < (k + 80 |0); j = j + 4 |0) {
          t1 = extended(H, j);
          t0 = roundL(y0, F0(y1, y2, y3)) + (roundR(y4, t1) + 1518500249 |0) |0;
          swap(y0, y1, y2, y3, y4, t0);
          H[j>>2] = t1;
        }

        for (j = k + 80 |0; (j|0) < (k + 160 |0); j = j + 4 |0) {
          t1 = extended(H, j);
          t0 = roundL(y0, F1(y1, y2, y3)) + (roundR(y4, t1) + 1859775393 |0) |0;
          swap(y0, y1, y2, y3, y4, t0);
          H[j>>2] = t1;
        }

        for (j = k + 160 |0; (j|0) < (k + 240 |0); j = j + 4 |0) {
          t1 = extended(H, j);
          t0 = roundL(y0, F2(y1, y2, y3)) + (roundR(y4, t1) - 1894007588 |0) |0;
          swap(y0, y1, y2, y3, y4, t0);
          H[j>>2] = t1;
        }

        for (j = k + 240 |0; (j|0) < (k + 320 |0); j = j + 4 |0) {
          t1 = extended(H, j);
          t0 = roundL(y0, F1(y1, y2, y3)) + (roundR(y4, t1) - 899497514 |0) |0;
          swap(y0, y1, y2, y3, y4, t0);
          H[j>>2] = t1;
        }

        y0 = y0 + z0 |0;
        y1 = y1 + z1 |0;
        y2 = y2 + z2 |0;
        y3 = y3 + z3 |0;
        y4 = y4 + z4 |0;

      }

      H[k+320>>2] = y0;
      H[k+324>>2] = y1;
      H[k+328>>2] = y2;
      H[k+332>>2] = y3;
      H[k+336>>2] = y4;

    }

    return {hash: hash};

  }

})();
