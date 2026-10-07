import type { Dispatch, SetStateAction } from 'react';
import type { ReadStamp } from '@git-view/contracts';
import type { ReadState } from '../features/feedback/read-feedback-policy';

/** Loading, failed and cancelled reads may retain the previous value and its stamp. */
export type Resource<T> = ReadState & { value?: T; stamp?: ReadStamp };
export type ResourceSetter<T> = Dispatch<SetStateAction<Resource<T>>>;
