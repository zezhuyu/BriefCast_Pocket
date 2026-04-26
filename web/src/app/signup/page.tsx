"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// desktop-ts is single-user — no account creation needed
export default function SignupPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, []);
  return null;
}
