import BeatClock from './beatclock';
import context from './audio/context';
import audioGraph from './audio-graph';

import {
  addPlaying,
  addScheduled,
  mediaEnded,
  flushScheduled,
  scheduleStop
} from '../data/scheduler';

import {
  AUDIO_BEHAVIOR_SINGLE,
  AUDIO_BEHAVIOR_SCHEDULABLE
} from '../data/clips';

export default {
  store: null,
  beatClock: null,

  init(storeObject) {
    const { settings: { bpm }} = storeObject.getState();
    this.store = storeObject;
    this.beatClock = new BeatClock();
    this.beatClock.on('bar', this.onBar.bind(this));
    this.beatClock.setBpm(bpm);
    this.beatClock.start();

    this.handleManualSchedule = this.handleManualSchedule.bind(this);
    this.scheduleRow = this.scheduleRow.bind(this);

    this.previouseBpm = bpm;
    this.store.subscribe(() => {
      const newBpm = storeObject.getState().settings.bpm;
      if (newBpm !== this.previouseBpm) {
        this.beatClock.setBpm(newBpm);
        this.previouseBpm = newBpm;
      }
    });
  },

  onBar() {
    const { clips, fileLoader, scheduler: { scheduled, toStop } } = this.store.getState();

    Object.keys(scheduled).forEach((clipId) => {
      const config = clips[clipId];
      const buffer = fileLoader[config.file];

      // file has not loaded
      if (!buffer) { return false; }

      this.playAudioNode(config);
    });

    Object.keys(toStop).forEach((clipId) => {
      this.stopAudioNode(clipId);
    });

    this.store.dispatch(flushScheduled());
  },

  handleManualSchedule(clipId, pad, x, y) {
    if (clipId) {
      this.scheduleClip(clipId);
    } else {
      // schedule a stop of all clips in the column
      this.stopVerticalClipsFromPosition(
        undefined,
        { pad, x },
        'schedule'
      );
    }
  },

  scheduleClip(clipId) {
    const { clips, scheduler: { scheduled, playing } } = this.store.getState();
    const clip = clips[clipId];
    const { behavior, id, loop } = clip;
    const isPlaying = playing[id];
    const isScheduled = scheduled[id];

    if (clip.type === 'audiosample') {
      // immediately play / stop the audio node
      if (behavior === AUDIO_BEHAVIOR_SINGLE) {
        if (!isPlaying) {
          this.playAudioNode(clip);
        } else {
          if (loop) {
            this.stopAudioNode(id);
          } else {
            this.stopAudioNode(id);
            this.playAudioNode(clip);
          }
        }
      } else if (behavior === AUDIO_BEHAVIOR_SCHEDULABLE) {
        // trigger a play or a stop
        if (isPlaying) {
          this.scheduleStopAudioNode(id);
        } else {
          if (!isScheduled) {
            this.scheduleAudioNode(id);
          }
        }
      }
    } else if (clip.type === 'video') {
      if (!isPlaying) {
        this.playVideo(clip);
      } else {
        this.stopVideo(clip.id);
        this.playVideo(clip);
      }
    }
  },

  scheduleRow(pad, rowY) {
    const rowClipIds = pad.clips[rowY];
    if (rowClipIds) {
      rowClipIds.forEach((clipId, x) => {
        this.stopVerticalClipsFromPosition(
          clipId,
          { pad, x },
          'schedule'
        );
        if (clipId) {
          this.scheduleClip(clipId);
        }
      });
    }
  },

  scheduleAudioNode(id) {
    this.store.dispatch(addScheduled(id));
  },

  scheduleStopAudioNode(id) {
    this.store.dispatch(scheduleStop(id));
  },

  playAudioNode({ file, loop, gain, id, track, behavior } = {}) {
    const { fileLoader } = this.store.getState();
    const buffer = fileLoader[file];
    const tracks = audioGraph.getTracks();
    const trackNode = tracks[track] || tracks['master'];

    // file has not loaded
    if (!buffer) { return false; }

    // stop all clips that are on the same vertical axis as this track
    const position = this.getPadPosition(id);
    this.stopVerticalClipsFromPosition(id, position);

    const audioNode = context.createBufferSource();
    const gainNode = context.createGain();
    audioNode.buffer = buffer;
    audioNode.loop = loop;
    gainNode.gain.value = gain;
    audioNode.connect(gainNode);
    gainNode.connect(trackNode);
    audioNode.start();
    audioNode.onended = () => this.stopAudioNode(id);
    this.store.dispatch(addPlaying(id, audioNode));
  },

  stopAudioNode(clipId) {
    const { scheduler: { playing } } = this.store.getState();
    const audioNode = playing[clipId];
    safeAudioStop(audioNode);
    this.store.dispatch(mediaEnded(clipId));
  },

  playVideo({ file, gain, id, track }) {
    const { fileLoader } = this.store.getState();
    const videoElement = fileLoader[file];
    // const tracks = audioGraph.getTracks();
    // TODO: router audio through web audio graph -> const trackNode = tracks[track] || tracks['master'];

    // file has not loaded
    if (!videoElement) { return false; }

    videoElement.pause();
    videoElement.play();
    videoElement.onended = () => this.stopVideo(id);

    this.store.dispatch(addPlaying(id, {videoElement}));
  },

  stopVideo(clipId) {
    const {clips, fileLoader} = this.store.getState();
    const fileId = clips[clipId].file;
    const videoElement = fileLoader[fileId];

    videoElement.pause();
    videoElement.onended = null;
    videoElement.currentTime = 0;
    this.store.dispatch(mediaEnded(clipId))
  },

  getPadPosition(id) {
    const { pads } = this.store.getState();
    let position = null;
    Object.keys(pads).some((padId) =>
      pads[padId].clips.some((row) => {
        const x = row.indexOf(id);
        if (x !== -1) {
          position = {
            pad: pads[padId],
            x
          };
          return true;
        }
        return false;
      })
    );
    return position;
  },

  getVerticalClipsFromPosition(position, clipId) {
    if (!position) { return []; }
    return position.pad.clips
      .map((row) =>
        row
          .map((currId, x) => x === position.x && clipId !== currId ? currId : undefined)
          .filter(Boolean)
      )
      .map((rowMatches) => rowMatches.length ? rowMatches[0] : undefined)
      .filter(Boolean);
  },

  stopVerticalClipsFromPosition(clipId, position, stopType) {
    const { scheduler: { playing } } = this.store.getState();
    const verticalClips = this.getVerticalClipsFromPosition(position, clipId);
    // stop all playing clips from the same vertical position
    Object
      .keys(playing)
      .forEach((playingId) => {
        if (verticalClips.indexOf(playingId) !== -1) {
          if (stopType === 'schedule') {
            this.scheduleStopAudioNode(playingId);
          } else {
            this.stopAudioNode(playingId);
          }
        }
      });
  }

};

function safeAudioStop(audioNode) {
  try {
    audioNode.stop();
    audioNode.disconnect();
  } catch(e) {}
}
