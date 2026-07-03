import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCodeScanner,
} from 'react-native-vision-camera';
import { theme } from '../theme/colors';

interface QrPairModalProps {
  visible: boolean;
  /** Fired once with the raw QR contents (the server's pairing payload JSON). */
  onScanned: (payload: string) => void;
  /** Fired when the user dismisses the scanner without a scan. */
  onClose: () => void;
}

type Permission = 'pending' | 'granted' | 'denied';

/**
 * Full-screen QR scanner for pairing: point the phone at the QR the server
 * prints, and the encoded {host,port,pin,code} payload is handed to the caller
 * to redeem for a token. Built on react-native-vision-camera's native code
 * scanner (no frame processors), so it needs the camera permission and a
 * device build — the module is inert in a JS-only reload.
 */
export default function QrPairModal({ visible, onScanned, onClose }: QrPairModalProps) {
  const device = useCameraDevice('back');
  const [permission, setPermission] = useState<Permission>('pending');
  // Guard against the scanner firing repeatedly for the same code in-frame.
  const handled = useRef(false);

  useEffect(() => {
    if (!visible) {
      handled.current = false;
      return;
    }
    let active = true;
    (async () => {
      const status = Camera.getCameraPermissionStatus();
      if (status === 'granted') {
        if (active) setPermission('granted');
        return;
      }
      const result = await Camera.requestCameraPermission();
      if (active) setPermission(result === 'granted' ? 'granted' : 'denied');
    })();
    return () => {
      active = false;
    };
  }, [visible]);

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      if (handled.current) return;
      const value = codes[0]?.value;
      if (!value) return;
      handled.current = true;
      onScanned(value);
    },
  });

  const message = useCallback(() => {
    if (permission === 'denied') {
      return 'Camera access is off. Enable it in Settings to scan the pairing QR.';
    }
    if (permission === 'granted' && !device) return 'No camera is available on this device.';
    return null;
  }, [permission, device]);

  const showCamera = permission === 'granted' && !!device;
  const note = message();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.fill}>
        {showCamera ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={visible}
            codeScanner={codeScanner}
          />
        ) : (
          <View style={styles.center}>
            {note ? (
              <Text style={styles.note}>{note}</Text>
            ) : (
              <ActivityIndicator color={theme.text} />
            )}
          </View>
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          {showCamera && <View style={styles.reticle} />}
          <Text style={styles.hint}>
            {showCamera ? 'Point at the pairing QR shown by the server' : ' '}
          </Text>
          <Pressable style={styles.cancel} onPress={onClose} hitSlop={12}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  note: { color: theme.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 240,
    height: 240,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: theme.accent,
    backgroundColor: 'transparent',
  },
  hint: {
    position: 'absolute',
    bottom: 140,
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  cancel: {
    position: 'absolute',
    bottom: 56,
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: theme.surface,
  },
  cancelText: { color: theme.text, fontSize: 16, fontWeight: '600' },
});
