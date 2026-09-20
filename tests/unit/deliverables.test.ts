import { describe, expect, it } from "vitest";
import {
  approveDeliverable,
  canClientReceiveFinal,
  canClientReview,
  checkRelease,
  completeStagingTransfer,
  finalLockReason,
  HONEST_LIMITS,
  markClientReview,
  markPaid,
  markPaymentPending,
  publishStaging,
  releaseDeliverable,
  requestStagingTransfer,
  sharePreview,
  stagingForClient,
  submitDeliverable,
  transitionDeliverable,
  FINAL_URL_TTL_SECONDS,
  PREVIEW_URL_TTL_SECONDS,
  DeliverableError,
} from "../../src/domain/deliverables.js";
import {
  ArtifactError,
  clampFinalTtl,
  clampPreviewTtl,
  mintObjectKey,
  sanitizeFileName,
  validateLinkUrl,
  validateVersionContent,
} from "../../src/lib/artifacts.js";

function draft() {
  return {
    id: "d1",
    title: "Logo pack",
    status: "draft" as const,
    currentVersionNo: 1,
    approvedVersionNo: null,
    stagingTransfer: "none" as const,
    stagingUrl: null,
  };
}

describe("deliverable lifecycle", () => {
  it("walks the controlled-delivery path draft → released", () => {
    let d = draft();
    d = submitDeliverable(d);
    expect(d.status).toBe("submitted");
    d = sharePreview(d);
    expect(d.status).toBe("preview_available");
    d = markClientReview(d);
    expect(d.status).toBe("client_review");
    d = approveDeliverable(d, 1);
    expect(d.status).toBe("approved");
    d = markPaymentPending(d);
    expect(d.status).toBe("payment_pending");
    d = markPaid(d);
    expect(d.status).toBe("paid");
    d = releaseDeliverable(d, {
      status: "paid",
      approvedVersionNo: 1,
      currentVersionNo: 1,
      verifiedPaid: true,
    });
    expect(d.status).toBe("released");
  });

  it("rejects illegal jumps", () => {
    expect(() => transitionDeliverable("draft", "released")).toThrow(DeliverableError);
    expect(() => transitionDeliverable("paid", "approved")).toThrow(DeliverableError);
    expect(() => transitionDeliverable("released", "draft")).toThrow(DeliverableError);
  });

  it("pins approval to an existing version", () => {
    expect(() => approveDeliverable(draft(), 0)).toThrow(DeliverableError);
    expect(() => approveDeliverable(draft(), 99)).toThrow(DeliverableError);
  });
});

describe("review vs final separation", () => {
  it("allows review early but finals only after release", () => {
    expect(canClientReview("draft")).toBe(false);
    expect(canClientReview("submitted")).toBe(false);
    expect(canClientReview("preview_available")).toBe(true);
    expect(canClientReview("client_review")).toBe(true);
    expect(canClientReview("approved")).toBe(true);
    expect(canClientReview("released")).toBe(true);
    for (const s of [
      "draft",
      "submitted",
      "preview_available",
      "client_review",
      "approved",
      "payment_pending",
      "paid",
    ] as const) {
      expect(canClientReceiveFinal(s)).toBe(false);
    }
    expect(canClientReceiveFinal("released")).toBe(true);
  });

  it("explains locks without leaking internals and never promises DRM", () => {
    expect(finalLockReason("draft")).toContain("unlock after review");
    expect(finalLockReason("paid")).toContain("being prepared");
    expect(HONEST_LIMITS).toContain("cannot prevent screenshots");
    expect(PREVIEW_URL_TTL_SECONDS).toBe(3600);
    expect(FINAL_URL_TTL_SECONDS).toBe(900);
  });

  it("blocks release without approval + verified paid", () => {
    const blocked = checkRelease({
      status: "approved",
      approvedVersionNo: 1,
      currentVersionNo: 1,
      verifiedPaid: false,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(" ")).toContain("verified");

    const stale = checkRelease({
      status: "paid",
      approvedVersionNo: 1,
      currentVersionNo: 2,
      verifiedPaid: true,
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reasons.join(" ")).toContain("superseded");

    const ok = checkRelease({
      status: "paid",
      approvedVersionNo: 2,
      currentVersionNo: 2,
      verifiedPaid: true,
    });
    expect(ok.allowed).toBe(true);

    // Flagged manual override with a real reason.
    const overridden = checkRelease({
      status: "approved",
      approvedVersionNo: 1,
      currentVersionNo: 1,
      verifiedPaid: false,
      manualOverrideReason: "Client is on-site tomorrow, trust is high",
    });
    expect(overridden.allowed).toBe(true);
    expect(overridden.overridden).toBe(true);

    const short = checkRelease({
      status: "approved",
      approvedVersionNo: 1,
      currentVersionNo: 1,
      verifiedPaid: false,
      manualOverrideReason: " asap ",
    });
    expect(short.allowed).toBe(false);
  });
});

describe("web-project staging model", () => {
  it("keeps staging review separate from final transfer", () => {
    const submitted = submitDeliverable(draft());
    expect(() => publishStaging(draft(), "https://staging.example/a")).toThrow(DeliverableError);
    expect(() => publishStaging(submitted, "http://insecure.example")).toThrow(DeliverableError);
    const live = publishStaging(submitted, "https://staging.example/a");
    expect(live.stagingTransfer).toBe("staging_live");
    // Transfer needs release first.
    expect(() => requestStagingTransfer(live)).toThrow(DeliverableError);
    const released = releaseDeliverable(
      {
        ...markPaid(
          markPaymentPending(approveDeliverable(markClientReview(sharePreview(submitted)), 1)),
        ),
      },
      { status: "paid", approvedVersionNo: 1, currentVersionNo: 1, verifiedPaid: true },
    );
    const withStaging = publishStaging(released, "https://staging.example/a");
    const pending = requestStagingTransfer(withStaging);
    expect(pending.stagingTransfer).toBe("transfer_pending");
    const done = completeStagingTransfer(pending);
    expect(done.stagingTransfer).toBe("transferred");
    expect(() => completeStagingTransfer(live)).toThrow(DeliverableError);
  });

  it("projects staging safely for the client", () => {
    const live = publishStaging(submitDeliverable(draft()), "https://staging.example/a");
    // Draft/submitted staging URL is not reviewable yet.
    expect(stagingForClient({ ...live, status: "submitted" }).stagingUrl).toBeNull();
    expect(stagingForClient({ ...live, status: "client_review" }).stagingUrl).toBe(
      "https://staging.example/a",
    );
    expect(stagingForClient({ ...live, status: "client_review" }).transferNote).toContain(
      "Staging preview is live",
    );
  });
});

describe("safe file handling", () => {
  it("accepts a mixed files + links + preview + description version", () => {
    const v = validateVersionContent({
      description: "First cut — watermarked preview plus source archive.",
      files: [
        {
          filename: "preview.png",
          contentType: "image/png",
          sizeBytes: 1024,
          visibility: "review",
        },
        {
          filename: "source.zip",
          contentType: "application/zip",
          sizeBytes: 2048,
          visibility: "final",
          sha256: "a".repeat(64),
        },
      ],
      links: ["https://example.com/spec"],
      previewText: "Look here first.",
      stagingUrl: "https://staging.example/site",
    });
    expect(v.files).toHaveLength(2);
    expect(v.links).toEqual(["https://example.com/spec"]);
  });

  it("rejects empty versions, bad types, oversized files, and non-https links", () => {
    expect(() => validateVersionContent({})).toThrow(ArtifactError);
    expect(() =>
      validateVersionContent({
        files: [
          {
            filename: "evil.exe",
            contentType: "application/x-msdownload",
            sizeBytes: 10,
            visibility: "review",
          },
        ],
      }),
    ).toThrow(ArtifactError);
    expect(() =>
      validateVersionContent({
        files: [
          {
            filename: "big.zip",
            contentType: "application/zip",
            sizeBytes: 500 * 1024 * 1024,
            visibility: "final",
          },
        ],
      }),
    ).toThrow(ArtifactError);
    expect(() => validateLinkUrl("http://insecure.example")).toThrow(ArtifactError);
    expect(() => validateLinkUrl("javascript:alert(1)")).toThrow(ArtifactError);
    expect(() =>
      validateVersionContent({
        files: [
          {
            filename: "a.png",
            contentType: "image/png",
            sizeBytes: 10,
            visibility: "review",
            sha256: "xyz",
          },
        ],
      }),
    ).toThrow(ArtifactError);
  });

  it("sanitizes filenames, mints opaque keys, and clamps TTLs", () => {
    expect(sanitizeFileName("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFileName("my logo (final).png")).toContain("my_logo");
    const key = mintObjectKey("deliv-1", 2);
    expect(key).toContain("deliv-1");
    expect(key).not.toContain("passwd");
    expect(clampPreviewTtl(99999)).toBe(PREVIEW_URL_TTL_SECONDS);
    expect(clampFinalTtl(99999)).toBe(FINAL_URL_TTL_SECONDS);
    expect(clampPreviewTtl(-5)).toBe(PREVIEW_URL_TTL_SECONDS);
  });
});
