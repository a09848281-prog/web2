package org.webrtc;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CaptureRequest;
import android.os.Handler;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Coordinates a live Camera2 repeating request without closing the video capture session. */
final class RemoteTorchState {
  private volatile boolean desiredEnabled;
  private volatile boolean appliedEnabled;
  private volatile boolean flashAvailable;
  private Handler cameraHandler;
  private CameraCaptureSession captureSession;
  private CaptureRequest.Builder requestBuilder;
  private volatile CountDownLatch ready = new CountDownLatch(1);

  void attach(CameraCaptureSession session, CaptureRequest.Builder builder,
      Handler handler, boolean available) {
    CountDownLatch previous = ready;
    ready = new CountDownLatch(1);
    cameraHandler = handler;
    captureSession = session;
    requestBuilder = builder;
    flashAvailable = available;
    if (!available) desiredEnabled = false;
    previous.countDown();
  }

  boolean isDesiredEnabled() {
    return desiredEnabled;
  }

  void markReady() {
    appliedEnabled = desiredEnabled && flashAvailable;
    ready.countDown();
  }

  void detach() {
    desiredEnabled = false;
    appliedEnabled = false;
    flashAvailable = false;
    cameraHandler = null;
    captureSession = null;
    requestBuilder = null;
    CountDownLatch previous = ready;
    previous.countDown();
    ready = new CountDownLatch(1);
  }

  void setEnabled(boolean enabled) throws Exception {
    desiredEnabled = enabled;
    if (!enabled && cameraHandler == null) {
      appliedEnabled = false;
      return;
    }
    final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
    while (true) {
      final CountDownLatch sessionReady = ready;
      final long remaining = deadline - System.nanoTime();
      if (remaining <= 0L || !sessionReady.await(remaining, TimeUnit.NANOSECONDS)) {
        desiredEnabled = false;
        throw new IllegalStateException("Camera2撮影セッションの準備がタイムアウトしました。");
      }
      if (ready == sessionReady) break;
      if (!enabled && cameraHandler == null) {
        appliedEnabled = false;
        return;
      }
    }
    if (enabled && !flashAvailable) {
      desiredEnabled = false;
      throw new IllegalStateException("選択中の背面カメラはフラッシュに対応していません。");
    }

    final Handler handler = cameraHandler;
    if (handler == null || captureSession == null || requestBuilder == null) {
      if (!enabled) {
        appliedEnabled = false;
        return;
      }
      desiredEnabled = false;
      throw new IllegalStateException("Camera2撮影リクエストを利用できません。");
    }

    final CountDownLatch completed = new CountDownLatch(1);
    final AtomicReference<Exception> failure = new AtomicReference<>();
    boolean posted = handler.post(() -> {
      try {
        if (captureSession == null || requestBuilder == null) {
          throw new IllegalStateException("カメラ撮影セッションが終了しています。");
        }
        if (enabled && !flashAvailable) {
          throw new IllegalStateException("このカメラではライトを利用できません。");
        }
        requestBuilder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
        requestBuilder.set(CaptureRequest.FLASH_MODE,
            enabled ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
        captureSession.setRepeatingRequest(requestBuilder.build(), null, handler);
        appliedEnabled = enabled;
      } catch (Exception error) {
        desiredEnabled = appliedEnabled;
        failure.set(error);
      } finally {
        completed.countDown();
      }
    });
    if (!posted || !completed.await(3, TimeUnit.SECONDS)) {
      desiredEnabled = appliedEnabled;
      throw new IllegalStateException("ライト設定の反映がタイムアウトしました。");
    }
    Exception error = failure.get();
    if (error != null) throw error;
  }

  boolean isEnabled() {
    return appliedEnabled;
  }

  boolean hasSupport() {
    return flashAvailable;
  }
}
