"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// desktop-ts has no multi-user auth — redirect straight to the app
export default function LoginPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, []);
  return null;
}
