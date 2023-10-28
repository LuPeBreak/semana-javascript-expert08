export default class VideoProcessor {
  #mp4Demuxer;
  #webMWriter;
  #service;
  #buffers = [];
  /**
   *
   * @param {object} options
   * @param {import('./mp4Demuxer.js').default options.mp4Demuxer}
   * @param {import('./../deps/webm-writer2.js').default options.webMWriter}
   * @param {import('./service.js').default options.service}
   */
  constructor({ mp4Demuxer, webMWriter, service }) {
    this.#mp4Demuxer = mp4Demuxer;
    this.#webMWriter = webMWriter;
    this.#service = service;
  }

  /** @returns {ReadableStream}  */
  mp4Decoder(stream) {
    return new ReadableStream({
      start: async (controller) => {
        const decoder = new VideoDecoder({
          /** @param {VideoFrame} frame */
          output(frame) {
            controller.enqueue(frame);
          },
          error(error) {
            console.error("error at mp4Decoder", error);
            controller.error(error);
          },
        });

        return this.#mp4Demuxer.run(stream, {
          async onConfig(config) {
            // const { supported } = await VideoDecoder.isConfigSupported(config);
            // if (!supported) {
            //   const errorMessage =
            //     "Mp4Demuxer videoDecoder config not supported";
            //   console.error(errorMessage, config);
            //   controller.error(errorMessage);
            //   return;
            // }
            decoder.configure(config);
          },
          /** @param {EncodedVideoChunk} chunk */
          onChunk(chunk) {
            decoder.decode(chunk);
          },
        });
        // .then(() => {
        //   setTimeout(() => {
        //     controller.close();
        //   }, 2000);
        // });
      },
    });
  }

  encode144p(encoderConfig) {
    let _encoder;
    const readable = new ReadableStream({
      start: async (controller) => {
        const { supported } = await VideoEncoder.isConfigSupported(
          encoderConfig
        );
        if (!supported) {
          console.error(
            "Encode144 videoEncoder config not supported",
            encoderConfig
          );
          controller.close();
          return;
        }

        _encoder = new VideoEncoder({
          /**
           *
           * @param {EncodedVideoChunk} frame
           * @param {EncodedVideoChunkMetadata} config
           */
          output: (frame, config) => {
            if (config.decoderConfig) {
              const decoderConfig = {
                type: "config",
                config: config.decoderConfig,
              };
              controller.enqueue(decoderConfig);
            }
            controller.enqueue(frame);
          },
          error: (error) => {
            console.error("VideoEncoder 144p", error);
            controller.error(error);
          },
        });

        await _encoder.configure(encoderConfig);
      },
    });
    const writable = new WritableStream({
      async write(frame) {
        _encoder.encode(frame);
        frame.close();
      },
    });
    return {
      readable,
      writable,
    };
  }

  renderDecodedFramesAndGetEncodedChunks(renderFrame) {
    let _decoder;
    return new TransformStream({
      start(controller) {
        _decoder = new VideoDecoder({
          output(frame) {
            renderFrame(frame);
          },
          error(error) {
            console.error("error at renderFrames", error);
            controller.error(error);
          },
        });
      },
      /**
       *
       * @param {EncodedVideoChunk} encodedChunk
       * @param {TransformStreamDefaultController} controller
       */
      async transform(encodedChunk, controller) {
        if (encodedChunk.type === "config") {
          await _decoder.configure(encodedChunk.config);
          return;
        }
        _decoder.decode(encodedChunk);

        // need the encoded version to use webm
        controller.enqueue(encodedChunk);
      },
    });
  }

  transformIntoWebM() {
    const writable = new WritableStream({
      write: (chunk) => {
        this.#webMWriter.addFrame(chunk);
      },
      close() {
        debugger;
      },
    });
    return {
      readable: this.#webMWriter.getStream(),
      writable,
    };
  }

  upload(filename, resolution, type) {
    const chunks = [];
    let byteCount = 0;
    let segmentCount = 0;

    const triggerUpload = async (chunks) => {
      const blob = new Blob(chunks, { type: `video/webm` });

      await this.#service.uploadFile({
        filename: `${filename}-${resolution}.${++segmentCount}.${type}`,
        fileBuffer: blob,
      });

      // reset chunks array
      chunks.length = 0;
      byteCount = 0;
    };

    return new WritableStream({
      /**
       *
       * @param {object} options
       * @param {Uint8Array} options.data
       */
      async write({ data }) {
        chunks.push(data);
        byteCount += data.byteLength;
        // less than 10mb do not upload
        if (byteCount <= 10e6) return;
        await triggerUpload(chunks);
        // renderFrame(frame);
      },
      async close() {
        if (!chunks.length) return;
        await triggerUpload(chunks);
      },
    });
  }

  async start({ file, encoderConfig, renderFrame, sendMessage }) {
    const stream = file.stream();
    const filename = file.name.split("/").pop().replace(".mp4", "");
    await this.mp4Decoder(stream)
      .pipeThrough(this.encode144p(encoderConfig))
      .pipeThrough(this.renderDecodedFramesAndGetEncodedChunks(renderFrame))
      .pipeThrough(this.transformIntoWebM())
      // .pipeThrough(
      //   new TransformStream({
      //     transform: ({ data, position }, controller) => {
      //       this.#buffers.push(data);
      //       controller.enqueue(data);
      //     },
      //     flush: () => {
      //       sendMessage({
      //         status: "done",
      //         // buffers: this.#buffers,
      //         // filename: filename.concat('-144p.webm'),
      //       });
      //     },
      //   })
      // )
      .pipeTo(this.upload(filename, "144p", "webm"));
    // .pipeTo(
    //   new WritableStream({
    //     write(frame) {
    //       // debugger;
    //       // renderFrame(frame);
    //     },
    //   })
    // );

    sendMessage({
      status: "done",
    });
  }
}
