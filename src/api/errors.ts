import { ApiError } from "./client";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Please try again.";
}

export function isApiError(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}
