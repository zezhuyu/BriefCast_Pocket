export default function imageLoader({ src, width, quality }) {
    // This runs on the client, so credentials will be included
    return `${src}`;
  } 