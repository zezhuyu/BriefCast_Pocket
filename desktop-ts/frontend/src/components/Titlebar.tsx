"use client"
import { useEffect, useState } from "react"
import { XMarkIcon, MinusIcon, ArrowsPointingOutIcon } from "@heroicons/react/20/solid"
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getName } from '@tauri-apps/api/app';

const isTauri = async () => {
  try {
    await getName();
    return true;
  } catch {
    return false;
  }
};
export default function Titlebar() {
  const [showBar, setShowBar] = useState(false)
  const [hovering, setHovering] = useState(false)

    useEffect(() => {
      isTauri().then((isTauri) => {
        if (isTauri) {
          setShowBar(true)
        }
      })
    }, [])

    if (!showBar) return null

    return (

      <div
          className="flex items-center relative z-50"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          >
              <div
              data-tauri-drag-region
              className="absolute top-0 left-0 h-9 w-full flex items-center px-3 gap-2 bg-white rounded-t-2xl"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
              {/* Close */}
              <div
                  id="close"
                  onClick={() => getCurrentWindow().close()}
                  className="relative w-3 h-3 bg-red-500 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors cursor-pointer"
              >
                  {hovering && (
                  <XMarkIcon className="absolute w-2 h-2 text-white opacity-80" />
                  )}
              </div>

              {/* Minimize */}
              <div
                  id="minimize"
                  onClick={() => getCurrentWindow().minimize()}
                  className="relative w-3 h-3 bg-yellow-500 rounded-full flex items-center justify-center hover:bg-yellow-600 transition-colors cursor-pointer"
              >
                  {hovering && (
                  <MinusIcon className="absolute w-2 h-2 text-white opacity-80" />
                  )}
              </div>

              {/* Maximize */}
              <div
                  id="maximize"
                  onClick={() => getCurrentWindow().toggleMaximize()}
                  className="relative w-3 h-3 bg-green-500 rounded-full flex items-center justify-center hover:bg-green-600 transition-colors cursor-pointer"
              >
                  {hovering && (
                  <ArrowsPointingOutIcon className="absolute w-2 h-2 text-white opacity-80" />
                  )}
              </div>
          </div>
      </div>
    )
}