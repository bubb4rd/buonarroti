import { Suspense } from "react";
import { GalleryStudio } from "@/components/gallery/GalleryStudio";

export default function GalleryPage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-paper" />}>
      <GalleryStudio />
    </Suspense>
  );
}
