declare module '@garmin/fitsdk' {
  export class Stream {
    static fromBuffer(buffer: Buffer): Stream;
  }

  export interface DecoderOptions {
    applyScaleAndOffset?: boolean;
    expandSubFields?: boolean;
    expandComponents?: boolean;
    convertTypesToStrings?: boolean;
    convertDateTimesToDates?: boolean;
    includeUnknownData?: boolean;
    mergeHeartRates?: boolean;
  }

  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(options?: DecoderOptions): unknown;
  }

  export class Encoder {
    onMesg(messageNumber: number, message: Record<string, unknown>): void;
    close(): Uint8Array;
  }

  export const Profile: {
    MesgNum: Record<string, number>;
  };
}
