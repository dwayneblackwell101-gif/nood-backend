import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import NoodSpinner from './NoodSpinner';

export type CameraSearchPhoto = {
  uri: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

type CameraSearchModalProps = {
  visible: boolean;
  onClose: () => void;
  onUsePhoto: (photo: CameraSearchPhoto) => void;
  onChooseAnother?: () => void;
};

type CameraStep = 'camera' | 'preview';

export default function CameraSearchModal({
  visible,
  onClose,
  onUsePhoto,
  onChooseAnother,
}: CameraSearchModalProps) {
  const cameraRef = useRef<any>(null);
  const zoomRef = useRef(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<CameraStep>('camera');
  const [capturedPhoto, setCapturedPhoto] = useState<CameraSearchPhoto | null>(null);
  const [takingPicture, setTakingPicture] = useState(false);
  const [zoom, setZoom] = useState(0);
  const pinchStartZoom = useSharedValue(0);

  const resetState = useCallback(() => {
    setStep('camera');
    setCapturedPhoto(null);
    setTakingPicture(false);
    setZoom(0);
    zoomRef.current = 0;
    pinchStartZoom.value = 0;
  }, [pinchStartZoom]);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const handleRetake = useCallback(() => {
    setCapturedPhoto(null);
    setStep('camera');
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || takingPicture) return;

    try {
      setTakingPicture(true);
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: true,
        skipProcessing: true,
      });

      if (!photo?.uri) return;

      setCapturedPhoto({
        uri: photo.uri,
        base64: photo.base64,
        mimeType: 'image/jpeg',
        width: photo.width,
        height: photo.height,
      });
      setStep('preview');
    } catch (error) {
      console.log('[NOOD camera] capture error', error);
    } finally {
      setTakingPicture(false);
    }
  }, [takingPicture]);

  const handleUsePhoto = useCallback(() => {
    if (!capturedPhoto) return;
    onUsePhoto(capturedPhoto);
    resetState();
    onClose();
  }, [capturedPhoto, onClose, onUsePhoto, resetState]);

  const applyZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(1, Math.max(0, nextZoom));
    zoomRef.current = clamped;
    setZoom(clamped);
    pinchStartZoom.value = clamped;
  }, [pinchStartZoom]);

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchStartZoom.value = zoomRef.current;
        })
        .onUpdate((event) => {
          runOnJS(applyZoom)(pinchStartZoom.value + (event.scale - 1) * 0.35);
        }),
    [applyZoom, pinchStartZoom]
  );

  const dismissPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          step === 'camera' &&
          gesture.dy > 14 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 120 || gesture.vy > 0.9) {
            handleClose();
          }
        },
      }),
    [handleClose, step]
  );

  const handleTapFocus = useCallback(async (event: any) => {
    const target = cameraRef.current as {
      focus?: (point: { x: number; y: number }) => Promise<void>;
    } | null;
    if (!target?.focus) return;

    const { locationX, locationY } = event.nativeEvent;
    try {
      await target.focus({ x: locationX, y: locationY });
    } catch {
      // Autofocus fallback is fine when focus is unavailable.
    }
  }, []);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <View style={styles.screen} {...(step === 'camera' ? dismissPanResponder.panHandlers : {})}>
        {step === 'camera' ? (
          <>
            <GestureDetector gesture={pinchGesture}>
              <Pressable style={styles.previewFill} onPress={handleTapFocus}>
                <CameraView
                  ref={cameraRef}
                  style={styles.previewFill}
                  facing="back"
                  zoom={zoom}
                  autofocus="on"
                />
              </Pressable>
            </GestureDetector>

            <SafeAreaView style={styles.controls} pointerEvents="box-none">
              <TouchableOpacity style={styles.closeButton} activeOpacity={0.85} onPress={handleClose}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>

              <Text style={styles.hintText}>Pinch to zoom · Tap to focus · Swipe down to close</Text>

              <TouchableOpacity
                style={styles.captureButton}
                activeOpacity={0.85}
                onPress={() => void handleCapture()}
                disabled={takingPicture}
              >
                {takingPicture ? (
                  <NoodSpinner size={32} />
                ) : (
                  <View style={styles.captureInner} />
                )}
              </TouchableOpacity>
            </SafeAreaView>

            {!permission?.granted ? (
              <View style={styles.permissionWrap}>
                <Text style={styles.permissionText}>Camera access is needed to search by photo.</Text>
                <TouchableOpacity
                  style={styles.permissionButton}
                  activeOpacity={0.9}
                  onPress={() => void requestPermission()}
                >
                  <Text style={styles.permissionButtonText}>Allow camera</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Image source={{ uri: capturedPhoto?.uri || '' }} style={styles.previewFill} resizeMode="contain" />

            <SafeAreaView style={styles.previewControls}>
              <Text style={styles.previewTitle}>Use this photo?</Text>
              <View style={styles.previewActions}>
                <TouchableOpacity style={styles.secondaryButton} activeOpacity={0.9} onPress={handleRetake}>
                  <Text style={styles.secondaryButtonText}>Retake</Text>
                </TouchableOpacity>
                {onChooseAnother ? (
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    activeOpacity={0.9}
                    onPress={onChooseAnother}
                  >
                    <Text style={styles.secondaryButtonText}>Choose Another</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.primaryButton} activeOpacity={0.9} onPress={handleUsePhoto}>
                  <Text style={styles.primaryButtonText}>Use Photo</Text>
                </TouchableOpacity>
              </View>
            </SafeAreaView>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewFill: {
    flex: 1,
    width: '100%',
  },
  controls: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 34,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  hintText: {
    alignSelf: 'center',
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  captureButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderWidth: 5,
    borderColor: 'rgba(255, 255, 255, 0.6)',
  },
  captureInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#111',
  },
  permissionWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 28,
    gap: 14,
  },
  permissionText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    fontWeight: '600',
  },
  permissionButton: {
    backgroundColor: '#ff6a00',
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  previewControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 14,
  },
  previewTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  previewActions: {
    flexDirection: 'row',
    gap: 12,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ff6a00',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
});
