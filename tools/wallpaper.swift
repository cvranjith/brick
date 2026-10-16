import Foundation
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

// Writes a JPEG of just the desktop wallpaper (no app windows) to argv[1], using ScreenCaptureKit.
// macOS keeps the wallpaper in a few windows below layer 0; some are blank, so take the first that has pixels.
func visible(_ img: CGImage) -> Bool {
  var px = [UInt8](repeating: 0, count: 16 * 16 * 4)
  guard let ctx = CGContext(data: &px, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: 16, height: 16))
  return px.enumerated().contains { $0.offset % 4 != 3 && $0.element > 12 }
}

let sem = DispatchSemaphore(value: 0)
var code: Int32 = 1
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw NSError(domain: "wallpaper", code: 2, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
    let wins = content.windows.filter { $0.windowLayer < 0 && $0.frame.intersects(display.frame) }.sorted { $0.windowLayer > $1.windowLayer }
    let scale = max(1, Int(NSScreen.main?.backingScaleFactor ?? 2))
    var found: CGImage?
    for w in wins {
      let cfg = SCStreamConfiguration()
      cfg.width = display.width * scale; cfg.height = display.height * scale; cfg.showsCursor = false
      let img = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, including: [w]), configuration: cfg)
      if visible(img) { found = img; break }
    }
    guard let img = found else { throw NSError(domain: "wallpaper", code: 3, userInfo: [NSLocalizedDescriptionKey: "no wallpaper window had pixels"]) }
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw NSError(domain: "wallpaper", code: 4) }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    if !CGImageDestinationFinalize(dest) { throw NSError(domain: "wallpaper", code: 5) }
    code = 0
  } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!) }
  sem.signal()
}
sem.wait()
exit(code)
