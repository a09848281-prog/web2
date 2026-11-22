package org.webrtc;

/** Public bridge for the Remote Camera app to control its active Camera2 capture request. */
public interface TorchCaptureControl {
  void setTorchEnabled(boolean enabled) throws Exception;
  boolean isTorchEnabled();
  boolean hasTorchSupport();
}
