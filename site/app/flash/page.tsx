"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";

export default function Flash() {
  const frame = useRef<HTMLIFrameElement>(null);
  const configure = () => frame.current?.contentWindow?.postMessage({type:"firmware-config",endpoint:process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT,project:process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID},window.location.origin);
  useEffect(() => { configure(); }, []);
  return <main style={{height:"100dvh",display:"flex",flexDirection:"column"}}>
    <nav style={{padding:"0.75rem 1rem"}}><Link href="/">Offgrid Tracker</Link></nav>
    <iframe ref={frame} title="nRF54L15 USB firmware flasher" src="/flasher/index.html" style={{flex:1,width:"100%",border:0}} onLoad={configure} />
  </main>;
}
