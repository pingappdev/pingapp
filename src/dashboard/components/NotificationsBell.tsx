import { formatDistanceToNow } from "date-fns";
import {
  ArrowDownLeft,
  Bell,
  CheckCircle2,
  CircleAlert,
  Clock3,
  PhoneOff,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMarkNotificationsRead, useNotifications } from "../../api/hooks";
import type { Notification } from "../../api/types";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

type NotificationPresentation = {
  message: string;
  href: string;
  icon: LucideIcon;
  warning?: boolean;
};

function dataText(data: Notification["data"], key: string, fallback: string): string {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function amountText(data: Notification["data"]): string {
  const amount = dataText(data, "amount", "an amount");
  const symbol = dataText(data, "symbol", "");
  return symbol ? `${amount} ${symbol}` : amount;
}

function present(notification: Notification): NotificationPresentation {
  const { data } = notification;
  switch (notification.type) {
    case "escrow_ready":
      return {
        message: "Your recipient joined PingApp and can claim their escrow.",
        href: "/dashboard/requests",
        icon: CheckCircle2,
      };
    case "escrow_incoming":
      return {
        message: "You have an escrow ready to claim.",
        href: "/dashboard/requests",
        icon: ArrowDownLeft,
      };
    case "escrow_claimed":
      return {
        message: "Your recipient claimed the escrow.",
        href: "/dashboard/requests",
        icon: CheckCircle2,
      };
    case "escrow_received":
      return {
        message: "Your escrow claim was confirmed.",
        href: "/dashboard/requests",
        icon: ArrowDownLeft,
      };
    case "escrow_refunded":
      return {
        message: "Your expired escrow was refunded.",
        href: "/dashboard/requests",
        icon: CheckCircle2,
      };
    case "intent_ready":
      return {
        message: `${dataText(data, "recipientDisplayName", "Your recipient")} joined PingApp. Complete your ${amountText(data)} send.`,
        href: dataText(data, "intentId", "")
          ? `/dashboard/send?intent=${encodeURIComponent(dataText(data, "intentId", ""))}`
          : "/dashboard/send",
        icon: CheckCircle2,
      };
    case "intent_expired":
      return {
        message: `Your pending send of ${amountText(data)} to ${dataText(data, "recipientPhoneMasked", "your recipient")} expired.`,
        href: "/dashboard/requests",
        icon: Clock3,
      };
    case "intent_incoming":
      return {
        message: `${dataText(data, "senderDisplayName", "Someone")} wants to send you ${amountText(data)}. They've been notified.`,
        href: "/dashboard",
        icon: ArrowDownLeft,
      };
    case "transfer_received":
      return {
        message: `You received ${amountText(data)} from ${dataText(data, "senderDisplayName", "another wallet")}.`,
        href: "/dashboard/activity",
        icon: ArrowDownLeft,
      };
    case "transfer_failed":
      return {
        message: `Your ${amountText(data)} transfer failed on-chain.`,
        href: "/dashboard/activity",
        icon: CircleAlert,
      };
    case "phone_claim_attempt":
      return {
        message: `Someone verified your number ${dataText(data, "phoneMasked", "on file")} from another wallet. If this wasn't you, contact support. Your number may be at risk.`,
        href: "/dashboard/settings",
        icon: ShieldAlert,
        warning: true,
      };
    case "phone_claim_resolved":
      return {
        message:
          dataText(data, "outcome", "") === "approved"
            ? `Your number ${dataText(data, "phoneMasked", "on file")} is now linked to this wallet.`
            : `Your request to link ${dataText(data, "phoneMasked", "your number")} was declined.`,
        href: "/dashboard/settings",
        icon: CheckCircle2,
      };
    case "phone_removed_by_review":
      return {
        message: `${dataText(data, "phoneMasked", "Your number")} was unlinked from this wallet after a review.`,
        href: "/dashboard/settings",
        icon: PhoneOff,
      };
  }
}

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const markReadNotifications = markRead.mutate;
  const items = useMemo(
    () => notifications.data?.items.slice(0, 20) ?? [],
    [notifications.data?.items],
  );
  const attemptedIds = useRef(new Set<string>());
  const unreadCount = notifications.data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const visibleUnreadIds = items
      .filter((item) => !item.readAt && !attemptedIds.current.has(item.id))
      .map((item) => item.id);
    if (visibleUnreadIds.length === 0) return;
    visibleUnreadIds.forEach((id) => attemptedIds.current.add(id));
    markReadNotifications(
      { ids: visibleUnreadIds },
      { onError: () => toast.error("Could not mark notifications as read.") },
    );
  }, [items, markReadNotifications, open]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) attemptedIds.current.clear();
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="notifications-trigger"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          aria-expanded={open}
        >
          <Bell size={17} />
          {unreadCount > 0 && (
            <span className="notifications-count" aria-hidden="true">
              {unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="notifications-popover" align="end" sideOffset={10}>
        <div className="notifications-heading">
          <div>
            <strong>Notifications</strong>
            <span>{unreadCount > 0 ? `${unreadCount} unread` : "You’re all caught up"}</span>
          </div>
          {unreadCount > 0 && (
            <button
              type="button"
              className="notifications-mark-all"
              disabled={markRead.isPending}
              onClick={() =>
                markRead.mutate(
                  { all: true },
                  { onError: () => toast.error("Could not mark notifications as read.") },
                )
              }
            >
              Mark all read
            </button>
          )}
        </div>
        {notifications.isPending ? (
          <p className="notifications-empty">Loading notifications…</p>
        ) : notifications.isError ? (
          <p className="notifications-empty" role="alert">
            Notifications could not be loaded.
          </p>
        ) : items.length === 0 ? (
          <p className="notifications-empty">You don’t have any notifications yet.</p>
        ) : (
          <ul className="notifications-list">
            {items.map((notification) => {
              const content = present(notification);
              const Icon = content.icon;
              const createdAt = new Date(notification.createdAt);
              return (
                <li key={notification.id}>
                  <a
                    className={`notification-item${notification.readAt ? "" : " unread"}${content.warning ? " warning" : ""}`}
                    href={content.href}
                    title={content.message}
                    onClick={() => setOpen(false)}
                  >
                    <span className="notification-icon">
                      <Icon size={16} />
                    </span>
                    <span className="notification-content">
                      <span className="notification-copy">{content.message}</span>
                      <time dateTime={notification.createdAt}>
                        {formatDistanceToNow(createdAt, { addSuffix: true })}
                      </time>
                    </span>
                    {!notification.readAt && <span className="notification-unread-dot" />}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
