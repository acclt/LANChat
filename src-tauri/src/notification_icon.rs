//! Small inline PNGs only. Bad icons degrade to text; never fetch an external URI.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::Cursor;

pub const MAX_BYTES: usize = 8 * 1024;
pub const MAX_BASE64: usize = MAX_BYTES.div_ceil(3) * 4;
pub const MAX_EDGE: u32 = 96;

pub fn decode(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() || value.len() > MAX_BASE64 {
        return None;
    }
    let bytes = STANDARD.decode(value).ok()?;
    if bytes.len() > MAX_BYTES
        || bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
        return None;
    }
    let mut decoder = png::Decoder::new(Cursor::new(&bytes));
    decoder.set_limits(png::Limits { bytes: 512 * 1024 });
    let mut reader = decoder.read_info().ok()?;
    if reader.info().animation_control.is_some() || reader.output_buffer_size() > 96 * 96 * 8 {
        return None;
    }
    let mut output = vec![0; reader.output_buffer_size()];
    reader.next_frame(&mut output).ok()?;
    reader.finish().ok()?;
    Some(bytes)
}

pub fn sanitize(value: Option<String>) -> Option<String> {
    value.and_then(|s| decode(&s).map(|bytes| STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn sample() -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[64, 128, 255, 255].repeat(4))
                .unwrap();
        }
        STANDARD.encode(bytes)
    }
    #[test]
    fn only_small_complete_static_pngs_are_accepted() {
        let valid = sample();
        assert!(decode(&valid).is_some());
        assert!(decode("https://example.com/icon.png").is_none());
        assert!(decode(&"A".repeat(MAX_BASE64 + 4)).is_none());
        let mut huge = STANDARD.decode(&valid).unwrap();
        huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(decode(&STANDARD.encode(huge)).is_none());
        let mut broken = STANDARD.decode(&valid).unwrap();
        broken.truncate(broken.len() - 14);
        assert!(decode(&STANDARD.encode(broken)).is_none());
    }
}
