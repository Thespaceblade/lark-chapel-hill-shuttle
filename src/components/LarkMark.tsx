import Image from "next/image";
import styles from "./LarkMark.module.css";

/** MTA-style circle badge: yellow field + lark silhouette to a vanishing point. */
export default function LarkMark({
  size = 44,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      className={`${styles.mark}${className ? ` ${className}` : ""}`}
      src="/lark-mark.png"
      alt="Lark"
      width={size}
      height={size}
      priority
    />
  );
}
