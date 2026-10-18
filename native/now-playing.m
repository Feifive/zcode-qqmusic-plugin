#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <objc/message.h>

// Read system playback metadata in a small, replaceable helper process.
// Account data and music caches are not accessed.
typedef void (*GetInfo)(dispatch_queue_t, void (^)(CFDictionaryRef));
typedef void (*GetPID)(dispatch_queue_t, void (^)(int));
typedef void (*GetPlaying)(dispatch_queue_t, void (^)(bool));
typedef bool (*SendCommand)(int, CFDictionaryRef);
typedef void (*SetElapsed)(double);

static void output(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); puts(""); fflush(stdout); }
}

static void read_playback(GetInfo getInfo, GetPlaying getPlaying, void (^completion)(NSDictionary *, BOOL)) {
    if (getPlaying) {
        getPlaying(dispatch_get_main_queue(), ^(bool playing) {
            getInfo(dispatch_get_main_queue(), ^(CFDictionaryRef raw) { completion((__bridge NSDictionary *)raw, playing); });
        });
    } else {
        getInfo(dispatch_get_main_queue(), ^(CFDictionaryRef raw) {
            NSDictionary *info = (__bridge NSDictionary *)raw;
            completion(info, [info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] doubleValue] > 0);
        });
    }
}

static void verify_playback(GetInfo getInfo, GetPID getPID, GetPlaying getPlaying, NSString *bundle, BOOL expectedPlaying, double deadline) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        getPID(dispatch_get_main_queue(), ^(int pid) {
            NSString *currentBundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier;
            if (![currentBundle isEqualToString:bundle]) {
                output(@{@"ok": @NO, @"error": @"player-changed"}); exit(0);
            }
            read_playback(getInfo, getPlaying, ^(NSDictionary *current, BOOL playing) {
                if (current.count && playing == expectedPlaying) {
                    output(@{@"ok": @YES, @"playing": @(playing)}); exit(0);
                }
                if (NSDate.date.timeIntervalSince1970 >= deadline) {
                    output(@{@"ok": @NO, @"error": @"command-not-applied"}); exit(0);
                }
                verify_playback(getInfo, getPID, getPlaying, bundle, expectedPlaying, deadline);
            });
        });
    });
}

static int read_media(int argc, const char *argv[]) {
    @autoreleasepool {
        void *handle = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY);
        GetInfo getInfo = handle ? dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") : NULL;
        GetPID getPID = handle ? dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationPID") : NULL;
        GetPlaying getPlaying = handle ? dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying") : NULL;
        SendCommand send = handle ? dlsym(handle, "MRMediaRemoteSendCommand") : NULL;
        SetElapsed seek = handle ? dlsym(handle, "MRMediaRemoteSetElapsedTime") : NULL;
        if (!getInfo || !getPID) { output(@{@"error": @"mediaremote-unavailable"}); return 1; }
        NSString *action = argc > 1 ? @(argv[1]) : @"snapshot";
        getPID(dispatch_get_main_queue(), ^(int pid) {
            NSString *bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier ?: @"";
            read_playback(getInfo, getPlaying, ^(NSDictionary *info, BOOL playing) {
                double now = NSDate.date.timeIntervalSince1970;
                if (![action isEqualToString:@"snapshot"]) {
                    // Recheck the source immediately before sending global media
                    // commands so a browser or another player is never controlled.
                    NSString *expected = argc > 2 ? @(argv[2]) : @"com.tencent.QQMusicMac";
                    if (!bundle.length || ![bundle isEqualToString:expected] || !info.count) {
                        output(@{@"ok": @NO, @"error": @"player-changed"}); exit(0);
                    }
                    NSDictionary *commands = @{@"play": @0, @"pause": @1, @"toggle": @2, @"next": @4, @"prev": @5};
                    NSNumber *command = commands[action];
                    if (command) {
                        BOOL accepted = NO;
                        Class controllerClass = NSClassFromString(@"MRNowPlayingController");
                        SEL localRoute = NSSelectorFromString(@"localRouteController");
                        SEL sendSelector = NSSelectorFromString(@"sendCommand:options:completion:");
                        if ([controllerClass respondsToSelector:localRoute]) {
                            id controller = ((id (*)(id, SEL))objc_msgSend)(controllerClass, localRoute);
                            if ([controller respondsToSelector:sendSelector]) {
                                ((void (*)(id, SEL, unsigned int, id, id))objc_msgSend)(controller, sendSelector, command.unsignedIntValue, @{}, nil);
                                accepted = YES;
                            }
                        } else if (send) {
                            accepted = send(command.intValue, NULL);
                        }
                        if (!accepted) {
                            output(@{@"ok": @NO, @"error": @"send-failed"}); exit(0);
                        }
                        BOOL beforePlaying = playing;
                        BOOL expectedPlaying = command.intValue == 0 || (command.intValue == 2 && !beforePlaying);
                        // MediaRemote sends asynchronously. A subsequent IPC read
                        // flushes the command before this short-lived process exits.
                        // For play/pause, also wait for the player to report the
                        // requested state instead of treating "sent" as success.
                        getPID(dispatch_get_main_queue(), ^(int currentPID) {
                            if (command.intValue <= 2) {
                                verify_playback(getInfo, getPID, getPlaying, expected, expectedPlaying, NSDate.date.timeIntervalSince1970 + 2);
                            } else {
                                output(@{@"ok": @YES}); exit(0);
                            }
                        });
                        return;
                    }
                    else if ([action isEqualToString:@"seek"] && seek && argc > 3) {
                        double position = strtod(argv[3], NULL);
                        if (isfinite(position) && position >= 0 && position <= 86400000) {
                            seek(position / 1000); output(@{@"ok": @YES});
                        } else output(@{@"ok": @NO, @"error": @"bad-position"});
                    } else output(@{@"ok": @NO, @"error": @"unsupported-action"});
                    exit(0);
                }
                if (!info.count || !bundle.length) {
                    output(@{@"at": @(now * 1000), @"sessions": @[]}); exit(0);
                }
                double rate = [info[@"kMRMediaRemoteNowPlayingInfoPlaybackRate"] doubleValue];
                double elapsed = [info[@"kMRMediaRemoteNowPlayingInfoElapsedTime"] doubleValue];
                id timestamp = info[@"kMRMediaRemoteNowPlayingInfoTimestamp"];
                if (playing && rate > 0 && [timestamp isKindOfClass:NSDate.class])
                    elapsed += MAX(0, now - [timestamp timeIntervalSince1970]) * rate;
                double duration = [info[@"kMRMediaRemoteNowPlayingInfoDuration"] doubleValue];
                if (duration > 0) elapsed = MIN(elapsed, duration);
                NSDictionary *session = @{
                    @"app": bundle, @"title": info[@"kMRMediaRemoteNowPlayingInfoTitle"] ?: @"",
                    @"artist": info[@"kMRMediaRemoteNowPlayingInfoArtist"] ?: @"",
                    @"album": info[@"kMRMediaRemoteNowPlayingInfoAlbum"] ?: @"",
                    @"status": playing ? @"playing" : @"paused",
                    @"timelineTimestamp": [timestamp isKindOfClass:NSDate.class] ? @([timestamp timeIntervalSince1970] * 1000) : @0,
                    @"reportedPosition": @([info[@"kMRMediaRemoteNowPlayingInfoElapsedTime"] doubleValue] * 1000),
                    @"position": @(MAX(0, elapsed) * 1000), @"duration": @(MAX(0, duration) * 1000),
                    // The framework does not reliably expose seek capability.
                    @"seek": @NO
                };
                output(@{@"at": @(now * 1000), @"sessions": @[session]}); exit(0);
            });
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            output(@{@"error": @"mediaremote-timeout"}); exit(1);
        });
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}

#ifdef ZCODE_MUSIC_LIBRARY
// macOS 15.4+ gates the legacy MediaRemote read functions by the caller's
// signing identity. Load this narrow adapter with the system Perl DynaLoader,
// following https://github.com/ungive/mediaremote-adapter (no SIP changes).
// The exported function never returns: the result callback exits the process.
__attribute__((visibility("default")))
void zcode_media_entry(void *context, void *cv) {
    const char *args[] = {
        "zcode-music",
        getenv("ZCODE_MUSIC_ACTION") ?: "snapshot",
        getenv("ZCODE_MUSIC_PLAYER") ?: "com.tencent.QQMusicMac",
        getenv("ZCODE_MUSIC_POSITION") ?: "0"
    };
    read_media(4, args);
}
#else
int main(int argc, const char *argv[]) { return read_media(argc, argv); }
#endif
