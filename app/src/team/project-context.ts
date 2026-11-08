import { createContext, useContext } from "react";
import type { Project } from "../api/team";

export const ProjectContext = createContext<Project | null>(null);
export function useOptionalProject() { return useContext(ProjectContext); }
