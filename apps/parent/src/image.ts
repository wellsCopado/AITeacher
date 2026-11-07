// Shrink a phone photo before upload: long side at most 2000 px, JPEG. Keeps handwriting readable at ~0.5 MB.
export async function downscale(file: File): Promise<{ mime: string; data: string }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  return { mime: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.85) };
}
