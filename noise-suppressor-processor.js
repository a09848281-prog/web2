// Adaptive noise gate for the received Android microphone stream.
// This is deterministic DSP, not AI or full spectral denoising. Higher values
// attenuate quiet background noise more aggressively and can also cut quiet speech.
class RemoteCameraNoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.strength = 70;
    this.noiseFloor = 0.0015;
    this.envelope = 1;
    this.port.onmessage = event => {
      const message = event.data || {};
      if (message.type === "strength") {
        const value = Number(message.value);
        this.strength = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (!output.length) return true;

    if (!input.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    let sum = 0;
    let sampleCount = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i];
        sum += sample * sample;
        sampleCount++;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, sampleCount));

    if (this.strength <= 0) {
      for (let ch = 0; ch < output.length; ch++) {
        const source = input[Math.min(ch, input.length - 1)];
        if (source) output[ch].set(source);
        else output[ch].fill(0);
      }
      this.envelope = 1;
      return true;
    }

    // Slowly follow the estimated quiet-room floor, but avoid adapting upward
    // too quickly while a person is speaking.
    if (rms < this.noiseFloor * 3.2) {
      this.noiseFloor = Math.max(0.00012, this.noiseFloor * 0.985 + rms * 0.015);
    }

    const threshold = this.noiseFloor * (1.1 + this.strength * 0.055)
      + this.strength * 0.000012;
    const target = rms < threshold
      ? Math.max(0.06, Math.min(1, rms / Math.max(threshold, 0.0001)))
      : 1;

    // Fast attenuation, slower release to avoid chattering and harsh cuts.
    const coefficient = target < this.envelope ? 0.5 : 0.1;
    this.envelope += (target - this.envelope) * coefficient;

    for (let ch = 0; ch < output.length; ch++) {
      const source = input[Math.min(ch, input.length - 1)];
      const destination = output[ch];
      if (!source) {
        destination.fill(0);
        continue;
      }
      for (let i = 0; i < destination.length; i++) {
        destination[i] = (source[i] || 0) * this.envelope;
      }
    }
    return true;
  }
}

registerProcessor("remote-camera-noise-gate", RemoteCameraNoiseGateProcessor);
