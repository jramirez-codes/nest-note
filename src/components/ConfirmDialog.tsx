import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button reads as a destructive action. */
  destructive?: boolean;
  /** Hide the cancel button, turning the dialog into a single-button notice. */
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A centered confirmation dialog styled with NativeWind. Replaces the OS Alert
 * so confirm/dismiss prompts match the app's Catppuccin surface. Tapping the
 * dimmed backdrop dismisses, mirroring the Cancel action.
 */
function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  hideCancel = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}>
      <Pressable
        className="flex-1 items-center justify-center bg-crust/70 px-8"
        onPress={onCancel}>
        {/* Stop presses on the card from bubbling to the backdrop. */}
        <Pressable
          className="w-full max-w-sm rounded-2xl border border-surface1 bg-surface0 p-6"
          onPress={() => {}}>
          <Text className="text-lg font-semibold text-text">{title}</Text>
          <Text className="mt-2 text-sm leading-5 text-muted">{message}</Text>

          <View className="mt-6 flex-row justify-end gap-3">
            {!hideCancel && (
              <Pressable
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
                className="rounded-xl px-4 py-2.5 active:opacity-70">
                <Text className="text-sm font-semibold text-muted">
                  {cancelLabel}
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              className={`rounded-xl px-4 py-2.5 active:opacity-80 ${
                destructive ? 'bg-danger' : 'bg-accent'
              }`}>
              <Text className="text-sm font-semibold text-crust">
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default React.memo(ConfirmDialog);
