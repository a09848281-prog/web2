package org.webrtc;

import android.content.Context;
import android.hardware.camera2.CameraManager;

/** WebRTC Camera2 capturer whose active repeating request can operate the rear torch. */
public final class RemoteTorchCamera2Capturer extends Camera2Capturer implements TorchCaptureControl {
  private final CameraManager cameraManager;
  private final RemoteTorchState torchState = new RemoteTorchState();

  public RemoteTorchCamera2Capturer(
      Context context, String cameraName, CameraVideoCapturer.CameraEventsHandler eventsHandler) {
    super(context, cameraName, eventsHandler);
    cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
  }

  @Override
  protected void createCameraSession(CameraSession.CreateSessionCallback createSessionCallback,
      CameraSession.Events events, Context applicationContext,
      SurfaceTextureHelper surfaceTextureHelper, String cameraName, int width, int height,
      int framerate) {
    RemoteTorchCamera2Session.create(createSessionCallback, events, applicationContext,
        cameraManager, surfaceTextureHelper, cameraName, width, height, framerate, torchState);
  }

  @Override
  public void setTorchEnabled(boolean enabled) throws Exception {
    torchState.setEnabled(enabled);
  }

  @Override
  public boolean isTorchEnabled() {
    return torchState.isEnabled();
  }

  @Override
  public boolean hasTorchSupport() {
    return torchState.hasSupport();
  }
}
