// Objective-C bridge that exposes the Swift AiNotepadSecure class to React
// Native. RCT_EXTERN_MODULE self-registers the module (no package list on iOS);
// both this file and AiNotepadSecure.swift must be members of the app target.

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(AiNotepadSecure, RCTEventEmitter)

RCT_EXTERN_METHOD(postPinned:(NSString *)url
                  pin:(NSString *)pin
                  headersJson:(NSString *)headersJson
                  body:(NSString *)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(openSocket:(double)id
                  url:(NSString *)url
                  pin:(NSString *)pin
                  headersJson:(NSString *)headersJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendSocket:(double)id text:(NSString *)text)

RCT_EXTERN_METHOD(closeSocket:(double)id)

@end
