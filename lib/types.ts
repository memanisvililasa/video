export type VideoFormat = {
  quality: string;
  format: string;
  size: string;
  downloadUrl: string;
};

export type AllowedVideoResponse = {
  status: "allowed";
  platform: string;
  title: string;
  author: string;
  duration: string;
  thumbnail: string;
  formats: VideoFormat[];
  isDemo?: boolean;
};

export type NotAllowedVideoResponse = {
  status: "not_allowed";
  platform: string;
  reason: string;
  officialOption: string;
};

export type ErrorVideoResponse = {
  status: "error";
  message: string;
};

export type CheckVideoResponse =
  | AllowedVideoResponse
  | NotAllowedVideoResponse
  | ErrorVideoResponse;
