import type { EditListEntry } from './moov/edit-list';

export interface VideoTrackMeta {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly rotationDegrees: 0 | 90 | 180 | 270;
  readonly nominalFrameRate: number;
  /** False if any two samples have different durations (stts has more than one distinct run value) -- i.e. this is a VFR track. */
  readonly constantDuration: boolean;
}

export interface AudioTrackMeta {
  readonly channelCount: number;
  readonly sampleRate: number;
  readonly language: string;
  /** hdlr's human-readable name -- e.g. distinguishing "Mic/Aux" from "Desktop Audio" in a multi-track OBS recording. '' if unset. */
  readonly handlerName: string;
}

export interface TrackIndex {
  readonly trackId: number;
  readonly kind: 'video' | 'audio' | 'other';
  /** 'vide', 'soun', 'tmcd', ... straight from hdlr. */
  readonly handlerType: string;
  /** RFC 6381 string, e.g. 'avc1.640034'. '' for 'other' tracks (no sample index is built for them). */
  readonly codec: string;
  readonly timescale: number;
  /** In this track's own timescale units -- see time.ts. */
  readonly duration: number;
  readonly sampleCount: number;
  /** Composition (presentation) time, in timescale units, decode-order indexed. */
  readonly pts: Float64Array;
  /** Decode time, in timescale units, decode-order indexed. */
  readonly dts: Float64Array;
  /** Absolute byte offset of each sample in the source, decode-order indexed. */
  readonly offset: Float64Array;
  readonly size: Uint32Array;
  /** 1 = sync sample, 0 = not. All-1 if the track has no stss (audio, or intra-only video). */
  readonly isSync: Uint8Array;
  /** Raw avcC/hvcC/esds bytes (including box header), copied verbatim. Empty for 'other' tracks. */
  readonly description: Uint8Array;
  readonly video?: VideoTrackMeta;
  readonly audio?: AudioTrackMeta;
  /**
   * Local (this track's own timescale) time that maps to presentation time 0 -- see
   * moov/edit-list.ts's computeEditOffset doc comment for how this is derived. 0 if there's no
   * edit list.
   */
  readonly editOffsetTicks: number;
  /** Present only if the track has an edts/elst box. Kept for display/debugging -- use editOffsetTicks for presentation-time math. */
  readonly editList?: EditListEntry[];
}
