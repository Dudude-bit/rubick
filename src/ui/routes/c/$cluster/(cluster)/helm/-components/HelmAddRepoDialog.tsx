import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/useT";

export interface HelmAddRepoDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Close the dialog */
  onClose: () => void;
  /** Repository name */
  name: string;
  onNameChange: (name: string) => void;
  /** Repository URL */
  url: string;
  onUrlChange: (url: string) => void;
  /** Add repository handler */
  onAdd: () => void;
  /** Whether add is in progress */
  isAdding: boolean;
}

export function HelmAddRepoDialog({
  open,
  onClose,
  name,
  onNameChange,
  url,
  onUrlChange,
  onAdd,
  isAdding,
}: HelmAddRepoDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("action", "addHelmRepository")}</DialogTitle>
          <DialogDescription>
            {t("action", "addHelmRepositoryHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="repo-name">{t("action", "repositoryName")}</Label>
            <Input
              id="repo-name"
              placeholder={t("action", "repositoryNamePlaceholder")}
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-url">{t("action", "repositoryUrl")}</Label>
            <Input
              id="repo-url"
              placeholder={t("action", "repositoryUrlPlaceholder")}
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={onAdd} disabled={!name || !url || isAdding}>
            {isAdding ? t("action", "adding") : t("action", "addRepository")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
