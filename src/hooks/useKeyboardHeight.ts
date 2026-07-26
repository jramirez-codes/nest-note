import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How much of the screen the on-screen keyboard covers, measured from the very
 * bottom edge — 0 while it's down. Pad a sheet's bottom by this (against the
 * safe-area inset, which it replaces while it's up) to keep something pinned
 * above the keyboard.
 *
 * For the pad itself nothing needs this. A Modal is a different matter: on
 * Android it's a separate window, and the app draws edge-to-edge, so nothing
 * moves the idea page's chat composer out of the keyboard's way on its own.
 *
 * The Android event reports the keyboard's height ABOVE the navigation bar,
 * which the keyboard also covers — so the nav bar's inset has to go back on, or
 * the bottom of the composer sits under the keyboard by exactly that much. iOS
 * measures from the screen edge already and needs no such correction.
 *
 * iOS also gets the `will` events so the sheet travels with the keyboard's
 * animation; Android only fires the `did` pair.
 */
export function useKeyboardHeight(): number {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', e =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  if (height === 0) return 0;
  return Platform.OS === 'ios' ? height : height + insets.bottom;
}
