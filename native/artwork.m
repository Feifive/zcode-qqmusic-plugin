#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>

static int fail_artwork(void) {
    fputs("{\"error\":\"artwork-thumbnail-failed\"}\n", stdout);
    return 1;
}

// Encoded artwork enters over stdin; a <=10px RGBA bitmap leaves over stdout.
int zcode_artwork_thumbnail(void) {
    @autoreleasepool {
        const NSUInteger limit = 2 * 1024 * 1024;
        NSMutableData *input = [NSMutableData data];
        unsigned char chunk[8192];
        size_t count;
        while ((count = fread(chunk, 1, sizeof(chunk), stdin)) > 0) {
            if (input.length + count > limit) return fail_artwork();
            [input appendBytes:chunk length:count];
        }
        if (ferror(stdin) || !input.length) return fail_artwork();
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)input, NULL);
        if (!source) return fail_artwork();
        NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
        double sourceWidth = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
        double sourceHeight = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
        if (sourceWidth < 1 || sourceHeight < 1 || sourceWidth > 4096 || sourceHeight > 4096) {
            CFRelease(source); return fail_artwork();
        }
        NSDictionary *options = @{
            (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @10,
            (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES
        };
        CGImageRef thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
        CFRelease(source);
        if (!thumbnail) return fail_artwork();
        size_t width = CGImageGetWidth(thumbnail), height = CGImageGetHeight(thumbnail);
        if (!width || !height || width > 10 || height > 10) { CGImageRelease(thumbnail); return fail_artwork(); }
        NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
        CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
        CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width * 4, space,
            kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
        CGColorSpaceRelease(space);
        if (!context) { CGImageRelease(thumbnail); return fail_artwork(); }
        CGContextSetBlendMode(context, kCGBlendModeCopy);
        // Same dimensions: normalize channels/alpha without another resize.
        CGContextDrawImage(context, CGRectMake(0, 0, width, height), thumbnail);
        CGContextRelease(context); CGImageRelease(thumbnail);
        NSDictionary *value = @{@"engine": @"imageio", @"width": @(width), @"height": @(height),
            @"order": @"rgba", @"pixels": [pixels base64EncodedStringWithOptions:0]};
        NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
        if (!json) return fail_artwork();
        fwrite(json.bytes, 1, json.length, stdout); puts("");
        return 0;
    }
}
