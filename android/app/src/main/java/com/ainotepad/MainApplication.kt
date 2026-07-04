package com.ainotepad

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.ainotepad.secure.AiNotepadSecurePackage
import com.ainotepad.recorder.AiNotepadRecorderPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // The pinned-networking module isn't autolinked (it lives in the app),
          // so register it by hand.
          add(AiNotepadSecurePackage())
          // Likewise the in-app audio recorder module (/record card).
          add(AiNotepadRecorderPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
