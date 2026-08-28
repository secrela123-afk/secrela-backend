import { z } from "zod";

export const createInvitationBodySchema = z.object({
  email: z
    .email("Enter a valid email")
    .max(320)
    .transform((v) => v.toLowerCase().trim()),
  roleId: z.string().min(1, "Select a role"),
});

export const acceptInvitationBodySchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "Invalid invitation token")
    .max(200, "Invalid invitation token"),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;
